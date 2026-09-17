/**
 * Persistent state for the r5-server CLI: the named server instances (each with
 * its own version, launch settings and mode template), the saved mode
 * templates, which instance is selected, and an operation history for auditing.
 *
 * 一个实例 = 一条记录（`ServerInstance`）。「正在运行的进程」属于实例（`runtime`），
 * 不再有全局单例 —— 同一台机器上可以同时跑多个实例，CLI 与面板的每个动作都作用在
 * **选中的那一个**（`selectedInstanceId`）上。
 *
 * 旧状态文件（`current`/`settings`/`profiles`/`runtime` 那套单实例形状）在这里一次性
 * 迁移成实例列表：每个档案对应一个实例，正在生效的那份设置与当时的运行记录落到
 * `currentProfile` 对应的实例上，其余实例只拿版本与各自的设置。
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEV_MODE, DEV_ROOT } from "./dev";
import type { ModeTemplate } from "./mode-templates";
import { APP_ROOT } from "./paths";

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
 * 这次运行**实际**带着什么起来的：启动设置快照 + 当时用的模板与其修订号。
 *
 * 面板据此区分两件事：「现在记录的设置」（可能已经改过、还没重启）与「这个进程真正
 * 在用的设置」（只有重启才会变）。引擎自己回报的运行期数据另有去处（`live` 与
 * `overrides`），三者不可互相冒充。
 */
export type AppliedLaunch = {
  settings: Settings;
  templateId: string | null;
  /**
   * 应用时的模板修订（`ModeTemplate.updatedAt`）。**只有整份模板真的落地了才写**：
   * 有键没写进实例的 playlist 文件时留 null（`templateMissing` 里是没落地的键）。
   */
  templateRevision: string | null;
  /** 启动参数里真正下发的模式 / 地图（模板优先于实例设置） */
  playlist: string;
  map: string;
  /** 启动参数里真正下发的模板覆盖项（cvar → 值） */
  overrides: Record<string, string>;
  /** 模板里声明了、但没能写进实例 playlist 文件的键（空 = 整份都落地了） */
  templateMissing: string[];
  at: string;
};

/** 运行期通过 `playlist_override_set` 下发、并由 `playlist_override_list` 回读确认的覆盖项。 */
export type AppliedOverride = { key: string; value: string; at: string };

export type Runtime = {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
  /**
   * 这个进程实际运行的那个引擎目录 —— 实例自己的可写工作副本。
   * 健康文件（`platform/logs/server/**`）、cfg、banlist 都按它定位。
   */
  engineDir: string;
  /** 实际可执行文件路径（`engineDir` 里的 r5apex_ds.exe）。 */
  exePath: string;
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
  /** 这次运行的启动快照（设置 + 模板修订） */
  applied?: AppliedLaunch;
  /** 运行期已确认生效的 playlist 覆盖（回读到什么记什么） */
  overrides?: AppliedOverride[];
};

export type HistoryEntry = {
  at: string;
  action: string;
  detail: string;
};

/**
 * 一个持久的服务器实例：名字 + 版本 + 启动设置 + 模式模板，以及它自己的运行记录。
 * 实例列表是持久的，进程是短暂的 —— `runtime` 只描述「现在跑着的那个进程」。
 */
export type ServerInstance = {
  id: string;
  name: string;
  /** 安装的版本目录名；null = 还没选版本（启动会明确报错） */
  version: string | null;
  settings: Settings;
  /** 选中的模式模板；null = 不用模板（只用实例设置） */
  templateId: string | null;
  runtime: Runtime | null;
  updatedAt: string;
};

export type State = {
  instances: ServerInstance[];
  templates: ModeTemplate[];
  selectedInstanceId: string | null;
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
  return APP_ROOT;
}

export const ROOT = detectRoot();
export const STATE_FILE = join(ROOT, "r5-server.json");
export const BACKUP_DIR = join(ROOT, "backups");

/** 每个实例的可写引擎工作副本都放在这下面（`instances/<id>/engine`）。 */
export const INSTANCES_DIR = join(ROOT, "instances");

let writerLock: Database | null = null;
let insideCommit = false;

/** SQLite owns the cross-process lock and releases it on crashes; JSON stays human-readable. */
function serializeState<T>(action: () => T): T {
  if (insideCommit) return action();
  if (writerLock === null) {
    mkdirSync(ROOT, { recursive: true });
    writerLock = new Database(join(ROOT, ".state-lock.sqlite"), { create: true });
    writerLock.exec("PRAGMA busy_timeout = 5000");
  }
  return writerLock
    .transaction(() => {
      insideCommit = true;
      try {
        return action();
      } finally {
        insideCommit = false;
      }
    })
    .immediate();
}

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

/** 全新状态（或迁移时无名可用）时的实例名。 */
export const DEFAULT_INSTANCE_NAME = "默认实例";

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

function readLive(raw: unknown): LiveLevel | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const playlist = readString(o.playlist, "");
  const map = readString(o.map, "");
  if (playlist.length === 0 && map.length === 0) return undefined;
  return { playlist, map, at: readString(o.at, "") };
}

function readApplied(raw: unknown): AppliedLaunch | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  return {
    settings: readSettings(o.settings),
    templateId: typeof o.templateId === "string" && o.templateId.length > 0 ? o.templateId : null,
    templateRevision:
      typeof o.templateRevision === "string" && o.templateRevision.length > 0 ? o.templateRevision : null,
    playlist: readString(o.playlist, ""),
    map: readString(o.map, ""),
    overrides: readOverrideMap(o.overrides),
    templateMissing: Array.isArray(o.templateMissing)
      ? o.templateMissing.filter((entry): entry is string => typeof entry === "string")
      : [],
    at: readString(o.at, ""),
  };
}

/** 覆盖项只收引擎认得的形状（cvar 名 + 字符串值）；其余一律丢掉。 */
function readOverrideMap(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_]+$/.test(key)) continue;
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
  }
  return out;
}

function readAppliedOverrides(raw: unknown): AppliedOverride[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AppliedOverride[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const o = entry as Record<string, unknown>;
    const key = readString(o.key, "");
    if (!/^[A-Za-z0-9_]+$/.test(key)) continue;
    out.push({ key, value: readString(o.value, ""), at: readString(o.at, "") });
  }
  return out.length > 0 ? out : undefined;
}

function readRuntime(raw: unknown): Runtime | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const pid = readNumber(o.pid, 0);
  if (pid <= 0) return null;
  const logdPid = readNumber(o.logdPid, 0);
  const ctlPort = readNumber(o.ctlPort, 0);
  return {
    pid,
    port: readNumber(o.port, 0),
    version: readString(o.version, ""),
    startedAt: readString(o.startedAt, ""),
    engineDir: readString(o.engineDir, ""),
    exePath: readString(o.exePath, ""),
    logdPid: logdPid > 0 ? logdPid : undefined,
    logFile: typeof o.logFile === "string" && o.logFile.length > 0 ? o.logFile : undefined,
    ctlPort: ctlPort > 0 ? ctlPort : undefined,
    ctlToken: typeof o.ctlToken === "string" && o.ctlToken.length > 0 ? o.ctlToken : undefined,
    live: readLive(o.live),
    applied: readApplied(o.applied),
    overrides: readAppliedOverrides(o.overrides),
  };
}

function readInstance(raw: unknown): ServerInstance | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = readString(o.id, "").trim();
  const name = readString(o.name, "").trim();
  if (id.length === 0 || name.length === 0) return null;
  const version = readString(o.version, "").trim();
  return {
    id,
    name,
    version: version.length > 0 ? version : null,
    settings: readSettings(o.settings),
    templateId: typeof o.templateId === "string" && o.templateId.length > 0 ? o.templateId : null,
    runtime: readRuntime(o.runtime),
    updatedAt: readString(o.updatedAt, ""),
  };
}

function readInstances(raw: unknown): ServerInstance[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const instances: ServerInstance[] = [];
  for (const entry of list) {
    const instance = readInstance(entry);
    if (instance === null || seen.has(instance.id)) continue;
    seen.add(instance.id);
    instances.push(instance);
  }
  return instances;
}

/** 模板形状由 `mode-templates.ts` 声明：这里只做 JSON 容错，不做语义校验。 */
function readTemplates(raw: unknown): ModeTemplate[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const templates: ModeTemplate[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const o = entry as Record<string, unknown>;
    const id = readString(o.id, "").trim();
    const name = readString(o.name, "").trim();
    if (id.length === 0 || name.length === 0 || seen.has(id)) continue;
    seen.add(id);
    templates.push({
      id,
      name,
      playlist: readString(o.playlist, ""),
      map: readString(o.map, ""),
      overrides: readOverrideMap(o.overrides),
      updatedAt: readString(o.updatedAt, ""),
    });
  }
  return templates;
}

function readHistory(raw: unknown): HistoryEntry[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((h): h is Record<string, unknown> => typeof h === "object" && h !== null)
    .map((h) => ({
      at: readString(h.at, ""),
      action: readString(h.action, ""),
      detail: readString(h.detail, ""),
    }));
}

/** 实例 id：目录名与状态文件都用它，所以只收小写十六进制 + 前缀。 */
export function newInstanceId(taken: Iterable<string> = []): string {
  const used = new Set(taken);
  for (;;) {
    const id = `inst-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    if (!used.has(id)) return id;
  }
}

/** 一条全新的实例记录（未选版本、默认设置、没有运行记录）。 */
export function newInstance(name: string, settings: Settings = defaultSettings): ServerInstance {
  return {
    id: newInstanceId(),
    name,
    version: null,
    settings: { ...settings },
    templateId: null,
    runtime: null,
    updatedAt: new Date().toISOString(),
  };
}

function freshState(): State {
  const instance = newInstance(DEFAULT_INSTANCE_NAME);
  return { instances: [instance], templates: [], selectedInstanceId: instance.id, history: [] };
}

/**
 * 把旧状态文件（单实例 + 档案）迁移成实例列表。
 *
 * 档案 → 实例（名字沿用档案名）；正在生效的档案拿到 `state.settings`（那是 CLI 唯一
 * 读过的值）与当时的运行记录，其余实例只拿各自的档案设置。版本只有一个（`current`），
 * 所以每个迁移出来的实例都指向它。
 */
function migrateLegacy(o: Record<string, unknown>): State {
  const settings = readSettings(o.settings);
  const legacyCurrent = typeof o.current === "string" && o.current.length > 0 ? o.current : null;
  const runtimeRaw = readRuntime(o.runtime);
  // 旧进程是在**已安装版本目录**里跑的（那时还没有工作副本）：把路径补齐，
  // 健康/日志/清单的路由才能照旧工作。
  const runtime =
    runtimeRaw === null || legacyCurrent === null
      ? runtimeRaw
      : { ...runtimeRaw, engineDir: join(ROOT, legacyCurrent), exePath: join(ROOT, legacyCurrent, "r5apex_ds.exe") };
  const profilesRaw = Array.isArray(o.profiles) ? o.profiles : [];
  const wanted = readString(o.currentProfile, "");
  const seen = new Set<string>();
  const ids = new Set<string>();
  const instances: ServerInstance[] = [];
  let activeId: string | null = null;
  for (const [index, entry] of profilesRaw.entries()) {
    if (typeof entry !== "object" || entry === null) continue;
    const profile = entry as Record<string, unknown>;
    const name = readString(profile.name, "").trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    const isActive = index === 0 ? wanted.length === 0 || wanted === name : wanted === name;
    const id = newInstanceId(ids);
    ids.add(id);
    const instance: ServerInstance = {
      id,
      name,
      version: legacyCurrent,
      settings: isActive ? { ...settings } : readSettings(profile.settings),
      templateId: null,
      runtime: isActive ? runtime : null,
      updatedAt: readString(profile.updatedAt, "") || new Date().toISOString(),
    };
    if (isActive && activeId === null) activeId = instance.id;
    instances.push(instance);
  }
  if (instances.length === 0) {
    const instance: ServerInstance = {
      ...newInstance(DEFAULT_INSTANCE_NAME, settings),
      version: legacyCurrent,
      runtime,
    };
    instances.push(instance);
    activeId = instance.id;
  }
  return {
    instances,
    templates: [],
    selectedInstanceId: activeId ?? instances[0]?.id ?? null,
    history: readHistory(o.history),
    ...(typeof o.panelRoute === "string" && o.panelRoute.startsWith("/") ? { panelRoute: o.panelRoute } : {}),
  };
}

export function loadState(): State {
  if (!existsSync(STATE_FILE)) return freshState();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`无法解析状态文件 ${STATE_FILE}：${(err as Error).message}`, { cause: err });
  }
  const hasInstances = Array.isArray(raw.instances);
  // 旧形状没有 `instances`：有单实例字段就迁移，什么都没有就当作全新状态。
  const legacy =
    !hasInstances &&
    (raw.profiles !== undefined ||
      raw.settings !== undefined ||
      raw.current !== undefined ||
      raw.runtime !== undefined);
  if (legacy) {
    if (!insideCommit) return serializeState(loadState);
    const migrated = migrateLegacy(raw);
    // 迁移结果**立刻落盘**：实例 id 是随机生成的，只放在内存里的话每个 CLI 进程都会
    // 重新迁移出另一套 id（工作副本、选中项、日志前缀全都对不上）。旧字段同时被清掉。
    saveState(migrated);
    return migrated;
  }
  const instances = readInstances(raw.instances);
  const wanted = readString(raw.selectedInstanceId, "");
  return {
    instances,
    templates: readTemplates(raw.templates),
    selectedInstanceId: instances.some((instance) => instance.id === wanted) ? wanted : (instances[0]?.id ?? null),
    history: readHistory(raw.history),
    ...(typeof raw.panelRoute === "string" && raw.panelRoute.startsWith("/") ? { panelRoute: raw.panelRoute } : {}),
  };
}

/** Replace-in-place save (temp file + rename) so a crash cannot truncate state. */
export function saveState(state: State): void {
  serializeState(() => {
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, STATE_FILE);
  });
}

export function record(state: State, action: string, detail: string): void {
  state.history.unshift({ at: new Date().toISOString(), action, detail });
  state.history = state.history.slice(0, 50);
}

/** 历史合并：同一时刻 + 同一动作 + 同一详情算同一条；按时间倒序，只留最近 50 条。 */
function mergeHistory(mine: HistoryEntry[], theirs: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set<string>();
  const merged: HistoryEntry[] = [];
  for (const entry of [...mine, ...theirs]) {
    const key = `${entry.at}\u0000${entry.action}\u0000${entry.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged.toSorted((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
}

/** 把合并后的结果写回调用方手里那个对象（面板把这个对象存在信号里，引用不能换）。 */
function adopt(state: State, disk: State): void {
  state.instances = disk.instances;
  state.templates = disk.templates;
  state.selectedInstanceId = disk.selectedInstanceId;
  state.history = disk.history;
  if (disk.panelRoute === undefined) delete state.panelRoute;
  else state.panelRoute = disk.panelRoute;
}

/**
 * **状态提交**：先重新读盘，再把这次调用真正改的东西合并进去，最后落盘。
 *
 * 为什么不能直接 `saveState(state)`（改完内存就整份写回）：启动/停止要等进程（加载地图
 * 10–30 秒），这段时间里别的进程可能已经写过状态文件 —— 另一个实例刚起来、面板刚改了名。
 * 整份写回会把那些改动整片覆盖掉，运行时记录被覆盖尤其致命：被覆盖的实例既停不掉、
 * 又占着端口，还和别人抢端口。
 *
 * 约定：`mutate(disk)` 里做的才是**这次调用拥有的改动**（校验失败直接抛错，此时一个
 * 字节都不会写出去）；历史记录按 (时间, 动作, 详情) 合并，不丢任何一方的条目。
 */
export function withState<T>(state: State, mutate: (disk: State) => T): T {
  return serializeState(() => {
    const disk = loadState();
    const result = mutate(disk);
    disk.history = mergeHistory(state.history, disk.history);
    saveState(disk);
    adopt(state, disk);
    return result;
  });
}

/** 选中的实例；没有实例或指针失效时为 null。 */
export function selectedInstance(state: State): ServerInstance | null {
  const id = state.selectedInstanceId;
  if (id === null) return null;
  return state.instances.find((instance) => instance.id === id) ?? null;
}

/** 选中的实例；没有就抛错（调用方要的是"明确说没有选中"，不是静默回退）。 */
export function requireInstance(state: State): ServerInstance {
  const instance = selectedInstance(state);
  if (!instance) throw new Error("没有选中的实例：先用 r5-server instance select <名字> 选一个。");
  return instance;
}
