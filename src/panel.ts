/**
 * 面板 API：界面（`src/routes/`、`src/components/`）唯一的数据入口。
 *
 * 这里只做两件事：**取值**（把共用采集器整理成给界面用的形状）与**动作**
 * （调用 `commands.ts` 里的实现，返回结果而不是打印）。
 * 文案、颜色、布局一律不在这里 —— 界面自己决定怎么说。
 *
 * 之所以单独一层而不是让界面直接 import `commands.ts`：`cmd*` 是「打印 + 退出码」
 * 形状，界面要的是可渲染的数据与可判断成败的结果；两边共用同一批实现，避免出现
 * 第二套启动/审核逻辑。
 *
 * 实例模型：动作默认作用于**选中的实例**（`state.selectedInstanceId`）；
 * 实例与模式模板的增删改查走本模块导出的 `*ServerInstance` / `*ModeTemplate`
 * （失败一律抛错并带上原因，界面用 `run()` 统一转成 notice）。
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
  type InstanceRow,
  type PlayerRow,
  type StartOptions,
  type StartOutcome,
  type StopResult,
  type TemplateApplyOptions,
  type TemplateApplyOutcome,
  NO_CONTROL_MESSAGE,
  NoControlChannelError,
  applyInstanceTemplate,
  botsAdd,
  botsClear,
  consoleWithReceipt,
  copyServerInstance,
  createServerInstance,
  deleteModeTemplate,
  deleteServerInstance,
  deleteServerInstanceAndWait,
  fetchBots,
  fetchPlayers,
  instancePendingChanges,
  instanceRows,
  listLogShards,
  logWatermark,
  moderate,
  newTemplateId,
  readAfter,
  readBanlist,
  saveModeTemplate,
  saveSettings,
  selectServerInstance,
  setLiveMode,
  startInstance,
  stopInstance,
  updateServerInstance,
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
import { findInstance, instanceVersionInfo, nextFreePort, portFamily, workspaceDir, workspaceReady } from "./instances";
import { type ModeTemplate, type TemplateField, templateFields, validateTemplate } from "./mode-templates";
import { type ModerationEntry, type ModerationFile, describeExpiry, loadModeration } from "./moderation";
import { type Receipt } from "./receipt";
import { type ServerMetrics, currentVersion, parseServerTitle } from "./serverinfo";
import { type FieldId, SETTINGS_FIELDS, type FieldDef, applyFieldValue, fieldById } from "./settings-fields";
import {
  STATE_FILE,
  type Runtime,
  ROOT,
  type ServerInstance,
  type Settings,
  type State,
  defaultSettings,
  loadState,
  record,
  requireInstance,
  saveState,
  selectedInstance,
} from "./state";
import { readDelta, readTailState, stripAnsi } from "./tap";
import { type VersionInfo, discoverVersions, formatSize } from "./versions";
import * as win from "./win";

export {
  ROOT,
  STATE_FILE,
  defaultSettings,
  loadState,
  saveState,
  record,
  fieldById,
  SETTINGS_FIELDS,
  formatSize,
  // 选中项与实例 / 模板的增删改查：界面唯一入口就是这些（失败抛错，原因照原样显示）。
  selectedInstance,
  requireInstance,
  createServerInstance,
  updateServerInstance,
  copyServerInstance,
  deleteServerInstance,
  deleteServerInstanceAndWait,
  selectServerInstance,
  instanceRows,
  instancePendingChanges,
  findInstance,
  nextFreePort,
  workspaceDir,
  workspaceReady,
  saveModeTemplate,
  deleteModeTemplate,
  newTemplateId,
  applyInstanceTemplate,
  templateFields,
  validateTemplate,
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
  InstanceRow,
  ModeFamily,
  ModeTemplate,
  ModerationFile,
  PlayerRow,
  Receipt,
  ServerInstance,
  ServerMetrics,
  Settings,
  StartOptions,
  StartOutcome,
  State,
  TemplateApplyOutcome,
  TemplateApplyOptions,
  TemplateField,
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

/**
 * 给**选中实例**换版本：只写实例记录的 `version`，不动任何版本目录内容。
 * 版本目录名不对（或没有选中的实例）返回 null。
 */
export function useVersion(state: State, name: string): VersionInfo | null {
  const instance = selectedInstance(state);
  if (instance === null) return null;
  const target = listVersions().find((version) => version.name === name) ?? null;
  if (!target) return null;
  updateServerInstance(state, instance.id, { version: target.name });
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

/** 某个实例的运行数据；进程没了就只回放 `runtime` 里的记录（`alive: false`）。 */
export async function collectInstanceMetrics(instance: ServerInstance): Promise<InstanceMetrics | null> {
  const runtime = instance.runtime;
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

/** 选中实例的运行数据（兼容旧调用点：面板多数页面看的就是选中实例）。 */
export async function collectInstance(state: State): Promise<InstanceMetrics | null> {
  const instance = selectedInstance(state);
  return instance === null ? null : await collectInstanceMetrics(instance);
}

/** 全机队的运行数据：每个实例一条，没在跑的就是 null（多实例总览用）。 */
export async function collectFleet(
  state: State,
): Promise<Array<{ instance: ServerInstance; metrics: InstanceMetrics | null }>> {
  const rows: Array<{ instance: ServerInstance; metrics: InstanceMetrics | null }> = [];
  for (const instance of state.instances) {
    rows.push({ instance, metrics: await collectInstanceMetrics(instance) });
  }
  return rows;
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
  return logSinkAlive(runtimeOfInstance(selectedInstance(state)));
}

/** 实例的运行记录（面板各处都从实例上取，没有实例就是 null）。 */
export function runtimeOfInstance(instance: ServerInstance | null): Runtime | null {
  return instance?.runtime ?? null;
}

/** 选中实例「改了但还没重启」的地方（空数组 = 记录与进程一致）。 */
export function selectedPendingChanges(state: State): string[] {
  const instance = selectedInstance(state);
  return instance === null ? [] : instancePendingChanges(state, instance);
}

/** 选中实例的引擎目录（进程真正在写的那份）；没有工作副本时是只读的安装目录。 */
export function instanceEngineDir(instance: ServerInstance | null): string | null {
  return instanceVersionInfo(instance)?.path ?? null;
}

// ------------------------------------------------------------------ 日志

export type LogShardView = { name: string; path: string; size: number; mtime: number; current: boolean; runId: string };

/** 选中实例的启动分片（最新在前）；没有运行记录时列出该实例全部前缀匹配的分片。 */
export function listRunShards(state: State): LogShardView[] {
  const instance = selectedInstance(state);
  const prefix = instance?.version == null ? null : `${instance.version}-${instance.settings.port}-`;
  const shards: LogShardView[] = [];
  for (const shard of listLogShards(instance?.runtime?.logFile)) {
    if (prefix !== null && !shard.name.startsWith(prefix)) continue;
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

/** 启动实例：默认启动**选中**的实例，`opts.instance` 可以点名别的实例。 */
export async function launchInstance(state: State, opts: StartOptions): Promise<StartOutcome> {
  return startInstance(state, opts, () => {});
}

/**
 * 停止实例。**没确认停止就抛错**（而不是返回 0 装作停过了）：界面把错误显示出来，
 * 实例记录仍然保留，可以再停一次。`all` 停掉所有有活进程记录的实例。
 */
export function killInstance(state: State, all = false): number {
  const stopped: StopResult = stopInstance(state, { all });
  if (stopped.error !== undefined) throw new Error(stopped.error);
  return stopped.killed;
}

export async function restartInstance(state: State, opts: StartOptions): Promise<StartOutcome> {
  const stopped = stopInstance(state, { instance: opts.instance });
  // 旧实例没停下来就不要再起一个：那会变成第二个进程抢同一个端口。
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

// ------------------------------------------------------------------ 设置

export type FieldValue = { id: FieldId; field: FieldDef; value: string; display: string; defaultValue: string };

/** 把一份设置摊平成界面好渲染的行（顺序 = `SETTINGS_FIELDS` 的声明顺序）。 */
export function settingsRows(settings: Settings): FieldValue[] {
  return SETTINGS_FIELDS.map((field) => ({
    id: field.id,
    field,
    value: field.editText(settings),
    display: field.display(settings),
    defaultValue: field.defaultText(settings),
  }));
}

/** 保存一批改动到**选中实例**（唯一入口就是 `commands.saveSettings`，面板与 worker 同路）。 */
export function updateSettings(
  state: State,
  changes: { id: FieldId; raw: string }[],
): { applied: string[]; failed: string[] } {
  return saveSettings(state, changes);
}

/** 把选中实例的某条设置项恢复成声明里的默认值。 */
export function resetField(state: State, id: FieldId): { applied: string[]; failed: string[] } {
  const field = fieldById(id);
  return saveSettings(state, [{ id, raw: String(field.defaultValue) }]);
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

/**
 * 写回文案表：保留原注释块与表头，只重写数据行（`renderAnnouncements` 负责）。
 *
 * 写的是**实例自己那份**文件：实例还没有工作副本时明确拒绝 —— 那时候唯一的落点是
 * 所有实例共用的安装目录，"改了公告却改到公共目录"比报错糟得多。
 */
export async function saveAnnouncements(state: State, rows: Announcement[]): Promise<AnnouncementWrite> {
  const instance = selectedInstance(state);
  if (instance === null) return { ok: false, error: "没有选中的实例。" };
  const version = currentVersion(state);
  if (!version) return { ok: false, error: "选中实例未选择版本目录，无法定位公告文案表" };
  if (!workspaceReady(instance)) {
    return {
      ok: false,
      error: `实例「${instance.name}」还没有自己的引擎目录（工作副本）：先在「运行中」页启动一次，再编辑公告文案 —— 否则改动会落到所有实例共用的安装目录里。`,
    };
  }
  for (const [index, row] of rows.entries()) {
    const problems = validateAnnouncement(row);
    if (problems.length > 0) return { ok: false, error: `第 ${index + 1} 行：${problems.join("；")}` };
  }
  const existing = await collectAnnouncements(version.path);
  const file = announcementsPath(version.path);
  writeFileSync(file, renderAnnouncements({ ...existing, rows }), "utf8");
  record(state, "announcements", `${instance.name}：写入 ${rows.length} 行`);
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

/**
 * 主机事实：**空实例列表也要能用**（主机配置页先于实例存在），所以按"所有已配置实例的
 * 整组端口"探测；一个实例都没有时用默认端口族。主机事实是全机级别的，不属于某个实例。
 */
export async function hostFacts(state: State): Promise<HostFacts | null> {
  const ports = state.instances.flatMap((instance) => portFamily(instance.settings.port));
  return collectHostFacts(ports.length > 0 ? ports : portFamily(defaultSettings.port));
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
