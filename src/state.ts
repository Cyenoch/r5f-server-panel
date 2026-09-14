/**
 * Persistent state for the r5-server CLI: which version is in use, launch
 * settings, the running instance, and an operation history for auditing.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type Visibility = 0 | 1 | 2;
export type AuthMode = 0 | 1 | 2;

/** 1v1 对战统计是否外发到 R5F 统计服务（fs_stats_url）。 */
export type StatsUpload = "default" | "off";

export type Settings = {
  port: number;
  map: string;
  playlist: string;
  hostname: string;
  visibility: Visibility;
  authMode: AuthMode;
  password: string;
  quotaString: number;
  quotaScript: number;
  /** 1v1/对战数据上报；"off" 会追加 +fs_stats_url ""（置空即关闭，引擎自述） */
  statsUpload: StatsUpload;
  /** 保留最近几次运行的日志分片（本机工具设置，不传给引擎） */
  logRetention: number;
  extra: string;
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
};

export type HistoryEntry = {
  at: string;
  action: string;
  detail: string;
};

export type State = {
  current: string | null;
  settings: Settings;
  runtime: Runtime | null;
  history: HistoryEntry[];
};

/** The directory holding r5-server.exe, its state file and one dir per version. */
function detectRoot(): string {
  const base = basename(process.execPath).toLowerCase();
  if (base === "bun.exe" || base === "bun") return resolve(import.meta.dir, "..");
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
  visibility: 0,
  authMode: 0,
  password: "",
  quotaString: 256,
  quotaScript: 128,
  statsUpload: "default",
  logRetention: 10,
  extra: "",
};

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
    visibility: clamp(readNumber(o.visibility, 0), 0, 2) as Visibility,
    authMode: clamp(readNumber(o.authMode, 0), 0, 2) as AuthMode,
    password: readString(o.password, ""),
    quotaString: readNumber(o.quotaString, defaultSettings.quotaString),
    quotaScript: readNumber(o.quotaScript, defaultSettings.quotaScript),
    statsUpload: o.statsUpload === "off" ? "off" : "default",
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
  };
}

export function loadState(): State {
  if (!existsSync(STATE_FILE)) {
    return { current: null, settings: { ...defaultSettings }, runtime: null, history: [] };
  }
  try {
    const o = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>;
    const historyRaw = Array.isArray(o.history) ? o.history : [];
    return {
      current: typeof o.current === "string" && o.current.length > 0 ? o.current : null,
      settings: readSettings(o.settings),
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
