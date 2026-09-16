/**
 * Persistent state for the r5-server CLI: which version is in use, launch
 * settings, the running instance, and an operation history for auditing.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DEV_MODE, DEV_ROOT } from "./dev";

export type Visibility = 0 | 1 | 2;
export type AuthMode = 0 | 1 | 2;

/** 1v1 对战统计是否外发到 R5F 统计服务（fs_stats_url）。 */
export type StatsUpload = "default" | "off";

/** 公告轮播开关（`bridge_chat_announce`，引擎默认关）。 */
export type AnnounceRotate = "default" | "on";

export type Settings = {
  port: number;
  map: string;
  playlist: string;
  hostname: string;
  /**
   * 对外上报的地址（cvar `hostip`）。NAT 主机上引擎自测只能得到 `[::1]:0`，
   * 主服据此判服务器不可达 —— 所以要用 `+hostip <公网IP>[:端口]` 显式改写。
   * 留空 = 不传这个参数（引擎用自测值）。
   */
  hostip: string;
  visibility: Visibility;
  authMode: AuthMode;
  password: string;
  quotaString: number;
  quotaScript: number;
  /** 1v1/对战数据上报；"off" 会追加 +fs_stats_url ""（置空即关闭，引擎自述） */
  statsUpload: StatsUpload;
  /** 公告轮播；"on" 会追加 +bridge_chat_announce 1（引擎默认 0 = 一条都不发） */
  announceRotate: AnnounceRotate;
  /** 保留最近几次运行的日志分片（本机工具设置，不传给引擎） */
  logRetention: number;
  extra: string;
};

/** 运行期实际生效的模式与地图：`bridge_setmode` 的回执里带了这两项。 */
export type LiveLevel = {
  playlist: string;
  map: string;
  /** 记下回执的时刻（ISO） */
  at: string;
};

/**
 * 一份命名的启动配置档案：`state.settings` 是**正在生效**的那份，档案是可以随时
 * 切回去的历史值。启动对话框选档案 = 把档案的 settings 复制进 `state.settings`，
 * 所以 CLI（只读 `settings`）看到的行为不会因为多了档案而改变。
 */
export type Profile = {
  name: string;
  settings: Settings;
  updatedAt: string;
};

export type Runtime = {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
  /** detached log-tap daemon pid, when hosted console streaming is active */
  logdPid?: number;
  /** log file the daemon appends to */
  logFile?: string;
  /** loopback control port for console commands (hosted console only) */
  ctlPort?: number;
  /** shared secret for the control port */
  ctlToken?: string;
  /** 运行中真正生效的模式与地图（来自最近的 bridge_setmode 回执，不是启动设置） */
  live?: LiveLevel;
};

export type HistoryEntry = {
  at: string;
  action: string;
  detail: string;
};

export type State = {
  current: string | null;
  settings: Settings;
  /** 命名配置档案；永远至少有一条，`currentProfile` 指向正在生效的那条 */
  profiles: Profile[];
  currentProfile: string;
  runtime: Runtime | null;
  history: HistoryEntry[];
  /** 面板上次停在哪一页：桌面端重开时回到原处，CLI 不读也不写。 */
  panelRoute?: string;
};

/** The directory holding r5-server.exe, its state file and one dir per version. */
function detectRoot(): string {
  // 开发模式（R5F_DEV=1）**优先**并压倒一切：状态、版本目录、日志全部落在沙箱里，
  // 桌面端传进来的 R5_SERVER_ROOT（仓库根）在这一层就不再被当作实例根目录。
  if (DEV_MODE) return DEV_ROOT;
  // 桌面端：宿主进程与 JS 子进程的 cwd/argv 都不是实例根目录，只能由宿主显式给出。
  const declared = process.env.R5_SERVER_ROOT;
  if (declared !== undefined && declared.trim().length > 0) return resolve(declared);
  const base = basename(process.execPath).toLowerCase();
  // Bun 的可执行名不止 `bun` / `bun.exe`：本机（vite-plus 装的 Bun）叫 `bun.native`。
  // 逐名精确匹配：编译产物也叫别的名字，宽前缀会把它们错当成解释器。
  if (base === "bun.exe" || base === "bun" || base === "bun.native") return resolve(import.meta.dir, "..");
  return dirname(process.execPath);
}

export const ROOT = detectRoot();
export const STATE_FILE = join(ROOT, "r5-server.json");
export const BACKUP_DIR = join(ROOT, "backups");

export const defaultSettings: Settings = {
  port: 37015,
  map: "mp_rr_arena_habitat",
  playlist: "fs_1v1",
  hostname: "R5F Server",
  hostip: "",
  visibility: 0,
  authMode: 0,
  password: "",
  quotaString: 256,
  quotaScript: 128,
  statsUpload: "default",
  announceRotate: "default",
  logRetention: 10,
  extra: "",
};

/** 没有任何档案时的档案名（也用于旧状态文件的迁移）。 */
export const DEFAULT_PROFILE = "默认配置";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function readNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Coerce JSON of unknown provenance into Settings; bad fields fall back. */
function readSettings(raw: unknown): Settings {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    port: clamp(Math.trunc(readNumber(o.port, defaultSettings.port)), 1, 65535),
    map: readString(o.map, defaultSettings.map),
    playlist: readString(o.playlist, defaultSettings.playlist),
    hostname: readString(o.hostname, defaultSettings.hostname),
    hostip: readString(o.hostip, defaultSettings.hostip),
    visibility: clamp(readNumber(o.visibility, 0), 0, 2) as Visibility,
    authMode: clamp(readNumber(o.authMode, 0), 0, 2) as AuthMode,
    password: readString(o.password, ""),
    quotaString: readNumber(o.quotaString, defaultSettings.quotaString),
    quotaScript: readNumber(o.quotaScript, defaultSettings.quotaScript),
    statsUpload: o.statsUpload === "off" ? "off" : "default",
    announceRotate: o.announceRotate === "on" ? "on" : "default",
    logRetention: clamp(Math.trunc(readNumber(o.logRetention, defaultSettings.logRetention)), 1, 1000),
    extra: readString(o.extra, ""),
  };
}

function readRuntime(raw: unknown): Runtime | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const pid = readNumber(o.pid, 0);
  if (pid <= 0) return null;
  const logdPid = readNumber(o.logdPid, 0);
  return {
    pid,
    port: readNumber(o.port, 0),
    version: readString(o.version, ""),
    startedAt: readString(o.startedAt, ""),
    logdPid: logdPid > 0 ? logdPid : undefined,
    logFile: typeof o.logFile === "string" && o.logFile.length > 0 ? o.logFile : undefined,
    ctlPort: readNumber(o.ctlPort, 0) > 0 ? readNumber(o.ctlPort, 0) : undefined,
    ctlToken: typeof o.ctlToken === "string" && o.ctlToken.length > 0 ? o.ctlToken : undefined,
    live: readLive(o.live),
  };
}

function readLive(raw: unknown): LiveLevel | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const playlist = readString(o.playlist, "");
  const map = readString(o.map, "");
  if (playlist.length === 0 && map.length === 0) return undefined;
  return { playlist, map, at: readString(o.at, "") };
}

function readProfiles(raw: unknown, settings: Settings): { profiles: Profile[]; currentProfile: string } {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const profiles: Profile[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const o = entry as Record<string, unknown>;
    const name = readString(o.name, "").trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    profiles.push({ name, settings: readSettings(o.settings), updatedAt: readString(o.updatedAt, "") });
  }
  // 旧状态文件（或档案被清空）时补一份默认档案，让 `currentProfile` 永远指向真实存在的一条。
  if (profiles.length === 0) {
    profiles.push({ name: DEFAULT_PROFILE, settings: { ...settings }, updatedAt: new Date().toISOString() });
  }
  return { profiles, currentProfile: profiles[0].name };
}

export function loadState(): State {
  if (!existsSync(STATE_FILE)) {
    return {
      current: null,
      settings: { ...defaultSettings },
      profiles: [{ name: DEFAULT_PROFILE, settings: { ...defaultSettings }, updatedAt: new Date().toISOString() }],
      currentProfile: DEFAULT_PROFILE,
      runtime: null,
      history: [],
    };
  }
  try {
    const o = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>;
    const historyRaw = Array.isArray(o.history) ? o.history : [];
    const settings = readSettings(o.settings);
    const named = readProfiles(o.profiles, settings);
    const wanted = readString(o.currentProfile, "");
    const panelRoute = typeof o.panelRoute === "string" && o.panelRoute.startsWith("/") ? o.panelRoute : undefined;
    return {
      panelRoute,
      current: typeof o.current === "string" && o.current.length > 0 ? o.current : null,
      settings,
      profiles: named.profiles,
      currentProfile: named.profiles.some((p) => p.name === wanted) ? wanted : named.currentProfile,
      runtime: readRuntime(o.runtime),
      history: historyRaw
        .filter((h): h is Record<string, unknown> => typeof h === "object" && h !== null)
        .map((h) => ({
          at: readString(h.at, ""),
          action: readString(h.action, ""),
          detail: readString(h.detail, ""),
        })),
    };
  } catch (err) {
    throw new Error(`无法解析状态文件 ${STATE_FILE}：${(err as Error).message}`, { cause: err });
  }
}

/** Replace-in-place save (temp file + rename) so a crash cannot truncate state. */
export function saveState(state: State): void {
  mkdirSync(ROOT, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, STATE_FILE);
}

export function record(state: State, action: string, detail: string): void {
  state.history.unshift({ at: new Date().toISOString(), action, detail });
  state.history = state.history.slice(0, 50);
}

/**
 * 把生效设置写回正在生效的档案。任何改动 `settings` 的路径都要调用它，
 * 否则档案会停在旧值、下次"用这个档案启动"就把改动悄悄吃掉。
 */
export function syncActiveProfile(state: State): void {
  const active = state.profiles.find((profile) => profile.name === state.currentProfile);
  if (!active) return;
  active.settings = { ...state.settings };
  active.updatedAt = new Date().toISOString();
}
