/**
 * 面板 API：桌面端（`desktop/`）唯一的数据入口。
 *
 * 这里只做两件事：**取值**（把 CLI 共用的采集器整理成给界面用的形状）与**动作**
 * （调用 `commands.ts` 里那些同样驱动 CLI 的实现，返回结果而不是打印）。
 * 文案、颜色、布局一律不在这里 —— 界面自己决定怎么说。
 *
 * 之所以单独一层而不是让界面直接 import `commands.ts`：`cmd*` 是「打印 + 退出码」
 * 形状，界面要的是可渲染的数据与可判断成败的结果；两边共用同一批实现，避免出现
 * 第二套启动/审核逻辑。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Announcement,
  type AnnouncementsFile,
  announcementsPath,
  collectAnnouncements,
  renderAnnouncements,
  validateAnnouncement,
} from "./announcements";
import { type Catalog, type ModeFamily, EMPTY_CATALOG, collectModes, loadCatalog } from "./catalog";
import { type CfgScan, cfgOverridesFor, readCfgScan } from "./cfg";
import {
  type PlayerRow,
  type StartOptions,
  type StartOutcome,
  type StopResult,
  NO_CONTROL_MESSAGE,
  NoControlChannelError,
  botsAdd,
  botsClear,
  consoleWithReceipt,
  fetchBots,
  fetchPlayers,
  listLogShards,
  logWatermark,
  moderate,
  readAfter,
  readBanlist,
  saveSettings,
  setLiveMode,
  startInstance,
  stopInstance,
} from "./commands";
import { DEV_MODE } from "./dev";
import { ensureDevFixtures } from "./dev-fixtures";
import {
  type Capability,
  type Health,
  type HostFacts,
  collectCapabilities,
  collectHealth,
  collectHostFacts,
  logSinkAlive,
} from "./inspect";
import { type ModerationEntry, type ModerationFile, describeExpiry, loadModeration } from "./moderation";
import { type Receipt } from "./receipt";
import { type ServerMetrics, currentVersion, parseServerTitle } from "./serverinfo";
import { type FieldId, SETTINGS_FIELDS, type FieldDef, applyFieldValue, fieldById } from "./settings-fields";
import {
  DEFAULT_PROFILE,
  STATE_FILE,
  type Profile,
  ROOT,
  type Settings,
  type State,
  defaultSettings,
  loadState,
  record,
  saveState,
} from "./state";
import { readDelta, readTailState, stripAnsi } from "./tap";
import { type VersionInfo, discoverVersions, formatSize } from "./versions";
import * as win from "./win";

export {
  ROOT,
  STATE_FILE,
  DEFAULT_PROFILE,
  defaultSettings,
  loadState,
  saveState,
  record,
  fieldById,
  SETTINGS_FIELDS,
  formatSize,
};
export { NO_CONTROL_MESSAGE, NoControlChannelError };
export type {
  Announcement,
  AnnouncementsFile,
  Capability,
  Catalog,
  CfgScan,
  FieldDef,
  FieldId,
  Health,
  HostFacts,
  ModeFamily,
  ModerationFile,
  PlayerRow,
  Profile,
  Receipt,
  ServerMetrics,
  Settings,
  StartOptions,
  StartOutcome,
  State,
  VersionInfo,
};

/** 动作结果：`"no-control"` 表示实例不是托管控制台启动的（界面统一按"要重启"处理）。 */
export type ActionResult<T> = T | "no-control";

/** 开发模式（R5F_DEV=1）：界面据此在标题栏打「模拟」标；数据本身由采集器各自标注。 */
export { DEV_MODE };

/**
 * 面板模块引导：补齐开发沙箱（fixtures + 状态文件）。
 *
 * 桌面端第一次 `loadState()` 之前必须已经就位（`session.ts` 会先 import 本模块），
 * 否则模拟实例选中的版本目录还不存在。非开发模式是空操作。
 */
ensureDevFixtures();

// ------------------------------------------------------------------ 版本

export function listVersions(withSizes = false): VersionInfo[] {
  return discoverVersions(ROOT, { withSizes });
}

export function activeVersion(state: State): VersionInfo | null {
  return currentVersion(state);
}

/** 换版本：只写 `state.current`，不动任何版本目录内容。 */
export function useVersion(state: State, name: string): VersionInfo | null {
  const target = listVersions().find((version) => version.name === name) ?? null;
  if (!target) return null;
  state.current = target.name;
  record(state, "use", target.name);
  saveState(state);
  return target;
}

// ------------------------------------------------------------------ 实例

export type InstanceMetrics = {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
  alive: boolean;
  /** 是否具备托管控制台（日志文件 + 控制口都在） */
  hosted: boolean;
  ctlPort?: number;
  logFile?: string;
  workingSetMB: number;
  privateMB: number;
  cpuSeconds: number;
  /** 引擎窗口标题里解析出的运行数据（人数/地图/模式/帧耗时…） */
  metrics: ServerMetrics | null;
  endpoints: string[];
  /** 运行中真正生效的模式与地图（`bridge_setmode` 回执），没有则回落启动设置 */
  live: { playlist: string; map: string; at: string } | null;
};

/** 当前实例的运行数据；进程没了就只回放 `runtime` 里的记录（`alive: false`）。 */
export async function collectInstance(state: State): Promise<InstanceMetrics | null> {
  const runtime = state.runtime;
  if (!runtime?.pid) return null;
  const proc = await win.getProcessAsync(runtime.pid);
  const metrics = proc ? parseServerTitle(proc.title) : null;
  return {
    pid: runtime.pid,
    port: runtime.port,
    version: runtime.version,
    startedAt: runtime.startedAt,
    alive: proc !== null,
    hosted: Boolean(runtime.logFile && runtime.ctlPort && runtime.ctlToken),
    ctlPort: runtime.ctlPort,
    logFile: runtime.logFile,
    workingSetMB: proc?.workingSetMB ?? 0,
    privateMB: proc?.privateMB ?? 0,
    cpuSeconds: proc?.cpuSeconds ?? 0,
    metrics,
    endpoints: proc ? await win.udpEndpointsAsync(proc.pid) : [],
    live: runtime.live ?? null,
  };
}

/** 本机上所有 `r5apex_ds` 进程（含不是本工具启动的）。 */
export async function collectDediProcesses(): Promise<win.ProcInfo[]> {
  return win.findDediProcessesAsync();
}

/**
 * 日志守护还活着吗：守护死了日志就不再增长，界面要如实说出来。
 *
 * 开发模式没有独立的守护进程 —— 模拟引擎自己写日志（启动时不设 `logdPid`），
 * 所以判断落在实例 pid 上；真实模式仍然只看 `logdPid`。
 */
export function logDaemonAlive(state: State): boolean {
  return logSinkAlive(state.runtime);
}

// ------------------------------------------------------------------ 日志

export type LogShardView = { name: string; path: string; size: number; mtime: number; current: boolean; runId: string };

/** 启动分片（最新在前）；`state.runtime` 没有日志文件时把整个 logs/ 列出来。 */
export function listRunShards(state: State): LogShardView[] {
  const shards: LogShardView[] = [];
  for (const shard of listLogShards(state.runtime?.logFile)) {
    const runId = /^(\d{8}-\d{6})\.log$/.exec(shard.name)?.[1] ?? shard.name.replace(/\.log$/, "");
    shards.push({ ...shard, runId });
  }
  return shards;
}

export type LogReader = {
  path: string | null;
  /** 已读到的全部行（含初始尾部） */
  lines: string[];
  /** 读一次增量，返回本次新增的行 */
  poll(): string[];
};

/**
 * 增量日志读取：初始取尾部 `tail` 行，此后按水位线只读新增部分。
 * 末行没写完（没有换行收尾）时水位线停在它起点，半行不会被当成整行。
 */
export function createLogReader(path: string | null, tail = 500): LogReader {
  const state = path && existsSync(path) ? readTailState(path, tail) : { lines: [], offset: 0 };
  const reader: LogReader = {
    path,
    lines: state.lines.map(stripAnsi),
    poll(): string[] {
      if (!reader.path) return [];
      const delta = readDelta(reader.path, state.offset);
      if (!delta) return [];
      state.offset = delta.offset;
      const fresh = delta.lines.map(stripAnsi).filter((line) => line.length > 0);
      reader.lines.push(...fresh);
      return fresh;
    },
  };
  return reader;
}

// ------------------------------------------------------------------ 动作

export async function launchInstance(state: State, opts: StartOptions): Promise<StartOutcome> {
  return startInstance(state, opts, () => {});
}

/**
 * 停止实例。**没确认停止就抛错**（而不是返回 0 装作停过了）：界面把错误显示出来，
 * 实例记录仍然保留，可以再停一次。
 */
export function killInstance(state: State, all = false): number {
  const stopped: StopResult = stopInstance(state, { all });
  if (stopped.error !== undefined) throw new Error(stopped.error);
  return stopped.killed;
}

export async function restartInstance(state: State, opts: StartOptions): Promise<StartOutcome> {
  const stopped = stopInstance(state, {});
  // 旧实例没停下来就不要再起一个：那会变成第二个实例（模拟模式更是直接拒绝）。
  if (stopped.error !== undefined) return { ok: false, error: stopped.error };
  return startInstance(state, { ...opts, force: true }, () => {});
}

/** 发一条控制台命令，返回回执（分类见 `receipt.ts`）。 */
export async function sendConsole(state: State, line: string, waitMs = 1200): Promise<ActionResult<Receipt>> {
  try {
    return await consoleWithReceipt(state, line, waitMs);
  } catch (err) {
    if (err instanceof NoControlChannelError) return "no-control";
    throw err;
  }
}

export { botsAdd, botsClear, moderate, setLiveMode, readBanlist, applyFieldValue };

export type ModerationVerb = "kick" | "ban" | "unban";

export type ModerationResult = {
  label: string;
  receipt: Receipt;
  /** 写进本机台账的封禁记录（只有 ban 有） */
  entry?: { name: string; id64: string; minutes: number; expiresAt: number };
};

export async function moderatePlayer(
  state: State,
  action: ModerationVerb,
  target: string,
  opts: { minutes?: number; reason?: string } = {},
): Promise<ActionResult<ModerationResult>> {
  const result = await moderate(state, action, target, opts);
  if (result === "no-control") return "no-control";
  if (!result.ok) throw new Error(result.error);
  return {
    label: result.label,
    receipt: result.receipt,
    entry: result.entry
      ? {
          name: result.entry.name,
          id64: result.entry.id64,
          minutes: result.entry.minutes,
          expiresAt: result.entry.expiresAt,
        }
      : undefined,
  };
}

export async function listBots(state: State): Promise<{ bots: PlayerRow[]; error?: string }> {
  return fetchBots(state);
}

export async function listPlayers(state: State): Promise<{ header: string[]; players: PlayerRow[]; error?: string }> {
  return fetchPlayers(state);
}

// ------------------------------------------------------------------ 设置与档案

export type FieldValue = { id: FieldId; field: FieldDef; value: string; display: string; defaultValue: string };

/** 把当前设置摊平成界面好渲染的行（顺序 = `SETTINGS_FIELDS` 的声明顺序）。 */
export function settingsRows(settings: Settings): FieldValue[] {
  return SETTINGS_FIELDS.map((field) => ({
    id: field.id,
    field,
    value: field.editText(settings),
    display: field.display(settings),
    defaultValue: field.defaultText(settings),
  }));
}

/** 保存一批改动（唯一入口就是 `commands.saveSettings`，CLI 与面板同路）。 */
export function updateSettings(
  state: State,
  changes: { id: FieldId; raw: string }[],
): { applied: string[]; failed: string[] } {
  return saveSettings(state, changes);
}

/** 把某条设置项恢复成声明里的默认值。 */
export function resetField(state: State, id: FieldId): { applied: string[]; failed: string[] } {
  const field = fieldById(id);
  return saveSettings(state, [{ id, raw: String(field.defaultValue) }]);
}

export type ProfileRow = Profile & { active: boolean; summary: string };

function profileSummary(settings: Settings): string {
  const parts = [
    settings.playlist.length > 0 ? settings.playlist : "玩家选模式",
    settings.map.length > 0 ? settings.map : "玩家选地图",
    `UDP ${settings.port}`,
  ];
  return parts.join(" · ");
}

export function listProfiles(state: State): ProfileRow[] {
  return state.profiles.map((profile) => ({
    ...profile,
    active: profile.name === state.currentProfile,
    summary: profileSummary(profile.settings),
  }));
}

/** 用某个档案启动 = 把档案的值复制进生效设置（CLI 只认 `settings`，语义不变）。 */
export function activateProfile(state: State, name: string): boolean {
  const profile = state.profiles.find((entry) => entry.name === name);
  if (!profile) return false;
  state.settings = { ...profile.settings };
  state.currentProfile = profile.name;
  record(state, "profile", `启用 ${profile.name}`);
  saveState(state);
  return true;
}

export type ProfileWrite = { ok: true; name: string } | { ok: false; error: string };

/** 新建档案：把当前生效设置存成一个新名字。 */
export function createProfile(state: State, name: string, from: Settings = state.settings): ProfileWrite {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, error: "档案名不能为空" };
  if (trimmed.length > 40) return { ok: false, error: "档案名最长 40 个字符" };
  if (state.profiles.some((profile) => profile.name === trimmed))
    return { ok: false, error: `已经有叫「${trimmed}」的档案` };
  state.profiles.push({ name: trimmed, settings: { ...from }, updatedAt: new Date().toISOString() });
  record(state, "profile", `新建 ${trimmed}`);
  saveState(state);
  return { ok: true, name: trimmed };
}

/** 用当前生效设置覆盖某个档案。 */
export function overwriteProfile(state: State, name: string): ProfileWrite {
  const profile = state.profiles.find((entry) => entry.name === name);
  if (!profile) return { ok: false, error: `找不到档案「${name}」` };
  profile.settings = { ...state.settings };
  profile.updatedAt = new Date().toISOString();
  record(state, "profile", `更新 ${name}`);
  saveState(state);
  return { ok: true, name };
}

export function renameProfile(state: State, from: string, to: string): ProfileWrite {
  const trimmed = to.trim();
  const profile = state.profiles.find((entry) => entry.name === from);
  if (!profile) return { ok: false, error: `找不到档案「${from}」` };
  if (trimmed.length === 0) return { ok: false, error: "档案名不能为空" };
  if (state.profiles.some((entry) => entry.name === trimmed && entry !== profile)) {
    return { ok: false, error: `已经有叫「${trimmed}」的档案` };
  }
  profile.name = trimmed;
  profile.updatedAt = new Date().toISOString();
  if (state.currentProfile === from) state.currentProfile = trimmed;
  record(state, "profile", `重命名 ${from} → ${trimmed}`);
  saveState(state);
  return { ok: true, name: trimmed };
}

/** 删除档案；最后一条不能删（`currentProfile` 必须始终指向存在的档案）。 */
export function deleteProfile(state: State, name: string): ProfileWrite {
  if (state.profiles.length <= 1) return { ok: false, error: "至少要保留一个配置档案" };
  const index = state.profiles.findIndex((entry) => entry.name === name);
  if (index < 0) return { ok: false, error: `找不到档案「${name}」` };
  const [removed] = state.profiles.splice(index, 1);
  if (state.currentProfile === name) {
    state.currentProfile = state.profiles[0]?.name ?? DEFAULT_PROFILE;
    const next = state.profiles[0];
    if (next) state.settings = { ...next.settings };
  }
  record(state, "profile", `删除 ${removed.name}`);
  saveState(state);
  return { ok: true, name: removed.name };
}

// ------------------------------------------------------------------ 目录 / 模式

export function currentCatalog(state: State): Catalog {
  const version = currentVersion(state);
  return version ? loadCatalog(version.path) : EMPTY_CATALOG;
}

export async function modeFamilies(state: State): Promise<ModeFamily[]> {
  const version = currentVersion(state);
  return version ? collectModes(version.path) : [];
}

export function cfgScan(state: State): CfgScan {
  const version = currentVersion(state);
  return readCfgScan(version?.path ?? null);
}

/** 某个启动设置项被引擎 cfg 覆盖成什么了（空数组 = 没有覆盖）。 */
export function cfgOverrides(state: State, id: FieldId): { file: string; value: string; line: number }[] {
  return cfgOverridesFor(cfgScan(state), id).map((entry) => ({
    file: entry.file,
    value: entry.value,
    line: entry.line,
  }));
}

// ------------------------------------------------------------------ 公告

export async function loadAnnouncements(state: State): Promise<AnnouncementsFile | null> {
  const version = currentVersion(state);
  return version ? collectAnnouncements(version.path) : null;
}

export type AnnouncementWrite = { ok: false; error: string } | { ok: true; path: string; rows: number };

/** 写回文案表：保留原注释块与表头，只重写数据行（`renderAnnouncements` 负责）。 */
export async function saveAnnouncements(state: State, rows: Announcement[]): Promise<AnnouncementWrite> {
  const version = currentVersion(state);
  if (!version) return { ok: false, error: "未选择版本目录，无法定位公告文案表" };
  for (const [index, row] of rows.entries()) {
    const problems = validateAnnouncement(row);
    if (problems.length > 0) return { ok: false, error: `第 ${index + 1} 行：${problems.join("；")}` };
  }
  const existing = await collectAnnouncements(version.path);
  const file = announcementsPath(version.path);
  writeFileSync(file, renderAnnouncements({ ...existing, rows }), "utf8");
  record(state, "announcements", `写入 ${rows.length} 行`);
  return { ok: true, path: file, rows: rows.length };
}

/** 立即广播轮播文案（`bridge_chat_announce`，引擎无回执 → 静默即"已发出"）。 */
export async function broadcastAnnouncements(state: State): Promise<ActionResult<Receipt>> {
  return sendConsole(state, "bridge_chat_announce");
}

// ------------------------------------------------------------------ 体检 / 主机

export async function health(state: State): Promise<Health> {
  return collectHealth(state);
}

export async function hostFacts(state: State): Promise<HostFacts | null> {
  return collectHostFacts([state.settings.port]);
}

export async function capabilities(state: State): Promise<Capability[]> {
  return collectCapabilities(state);
}

// ------------------------------------------------------------------ 台账

export function moderationLedger(): ModerationFile {
  return loadModeration(ROOT);
}

export function describeEntryExpiry(entry: ModerationEntry, now = Date.now()): string {
  return describeExpiry(entry, now);
}

/** 日志水位线（面板动作要把"动作之后的引擎输出"单独读出来时用）。 */
export function watermark(path: string): Promise<number> {
  return logWatermark(path);
}

export async function readSince(path: string, offset: number): Promise<string[]> {
  return readAfter(path, offset);
}

/** 日志文件是否存在且在被追加（守护活着但引擎没输出时也要如实区分）。 */
export function logFileState(path: string | undefined): { exists: boolean; size: number } {
  if (!path || !existsSync(path)) return { exists: false, size: 0 };
  return { exists: true, size: statSync(path).size };
}

/** 读一个文件的文本内容（面板要展示 cfg / banlist 原文时用）。 */
export function readText(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function versionDir(state: State): string | null {
  return currentVersion(state)?.path ?? null;
}

export function logDirPath(): string {
  return join(ROOT, "logs");
}
