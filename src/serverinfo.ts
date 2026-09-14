/**
 * Version/log parsers shared by the CLI commands and the TUI.
 *
 * Kept separate from commands.ts so data collectors can use them without an
 * import cycle (commands -> inspect -> serverinfo).
 */
import { ROOT, type State } from "./state";
import { readTail, stripAnsi } from "./tap";
import { type VersionInfo, discoverVersions, formatSize } from "./versions";

export function describe(v: VersionInfo): string {
  const bits: string[] = [];
  if (v.sizeBytes >= 0) bits.push(formatSize(v.sizeBytes));
  if (v.files >= 0) bits.push(`${v.files} 个文件`);
  if (v.gameVersion) bits.push(`game ${v.gameVersion}`);
  if (v.build) bits.push(v.build);
  return bits.join("  ·  ");
}

export function currentVersion(state: State): VersionInfo | null {
  if (!state.current) return null;
  return discoverVersions(ROOT, { withSizes: false }).find((v) => v.name === state.current) ?? null;
}

/** Title shape: "NAME - 0/60 Players (playlist on map) - 6% Server CPU (50.001 msec on frame 1413)". */
export type ServerMetrics = {
  players?: string;
  playlist?: string;
  map?: string;
  cpuPercent?: string;
  frameMs?: string;
  frame?: string;
};

export function parseServerTitle(title: string): ServerMetrics {
  const m = /^(.*?)\s-\s(\d+\/\d+)\s+Players\s+\(([^)]*)\s+on\s+([^)]*)\)\s-\s(.*)$/.exec(title);
  if (!m) return {};
  const tail = m[5];
  const cpu = /([\d.]+)%\s+Server CPU/.exec(tail);
  const frame = /\(([\d.]+)\s*msec on frame (\d+)\)/.exec(tail);
  return {
    players: m[2],
    playlist: m[3].trim(),
    map: m[4].trim(),
    cpuPercent: cpu?.[1],
    frameMs: frame?.[1],
    frame: frame?.[2],
  };
}

/**
 * Human uptime. `compact` is the dashboard's narrow form ("2h 5m"), the default
 * is the CLI wording ("2 小时 5 分"). Empty when the timestamp is unusable.
 */
export function formatUptime(startedAtIso: string, startedAtRaw: string, compact = false): string {
  let start = Date.parse(startedAtIso);
  if (!Number.isFinite(start)) {
    const m = /\/Date\((\d+)\)\//.exec(startedAtRaw);
    start = m ? Number(m[1]) : NaN;
  }
  if (!Number.isFinite(start)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - start) / 1000));
  const h = Math.floor(seconds / 3600);
  const min = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (compact) return h > 0 ? `${h}h ${min}m` : min > 0 ? `${min}m ${s}s` : `${s}s`;
  return h > 0 ? `${h} 小时 ${min} 分` : min > 0 ? `${min} 分 ${s} 秒` : `${s} 秒`;
}

/** What the log can tell us when the engine has no window (hosted console). */
export type LogSummary = {
  gameState?: string;
  mapInit?: string;
  playlist?: string;
  lastLine?: string;
  lastStamp?: string;
};

/** 引擎状态机取值 → 中文；未知取值不给词（面板宁可不显示，也不暴露内部状态名）。 */
const GAME_STATE_LABELS: Record<string, string> = {
  WaitingForPlayers: "等待玩家",
  Playing: "对局进行中",
  Running: "运行中",
  Loading: "加载中",
};

export function gameStateLabel(raw: string | undefined): string {
  return raw ? (GAME_STATE_LABELS[raw] ?? "") : "";
}

export function summariseLog(file: string): LogSummary {
  const lines = readTail(file, 400);
  const summary: LogSummary = {};
  for (const raw of lines) {
    const line = stripAnsi(raw);
    const strip = /^\[([\d.]+)\]\s*(.*)$/.exec(line);
    const text = strip ? strip[2] : line;
    if (strip) summary.lastStamp = strip[1];
    const state = /Setting game state to:\s*(.+)$/i.exec(text);
    if (state) summary.gameState = state[1].trim();
    const mapInit = /([A-Za-z0-9]+)_MapInit_/.exec(text);
    if (mapInit) summary.mapInit = mapInit[1];
    const playlist = /playlist[=: ]+([a-z0-9_]+)/i.exec(text);
    if (playlist) summary.playlist = playlist[1];
    if (text.trim().length > 0) summary.lastLine = text.trim();
  }
  return summary;
}
