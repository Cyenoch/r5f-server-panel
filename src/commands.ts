import { randomUUID } from "node:crypto";
/**
 * 面板共用的业务实现：启动/停止、实例与模式模板、主机配置（setup/自启）、
 * 托管控制台通道、玩家与审核、机器人、封禁名单、公告、运行期模式热切。
 *
 * 三条入口用同一份实现：面板（`panel.ts` 的进程内调用）、内部 worker
 * （`cmdStart` / `cmdSetup` / `cmdAutostart`，见 `worker.ts`）、计划任务。`cmd*`
 * 只负责「打印 + 退出码」，取值与动作本身都是下面这些不打印的函数。
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { type ModeEntry, type ModeFamily, collectModes, mapsForPlaylist } from "./catalog";
import { type CfgSync, PLAYLIST_FILE, applyPlaylistOverrides, playlistBaseline, syncLaunchSettings } from "./cfg";
import { DEV_MODE } from "./dev";
import { autostartDevHost, setupDevHost } from "./dev-host";
import { devEngineSnapshotDir } from "./dev-protocol";
import {
  acquireStartLock,
  ensureWorkspace,
  findInstance,
  instancePorts,
  nextFreePort,
  portFamily,
  releaseVersion,
  removeWorkspace,
  workspaceDir,
} from "./instances";
import { type ModeTemplate, templateCommands, templateFields, validateTemplate } from "./mode-templates";
import { type ModerationEntry, addRecord, loadModeration, markUnbannedByTarget } from "./moderation";
import { type Receipt, type ReceiptKind, classifyReceipt, normaliseLogLine } from "./receipt";
import { currentVersion } from "./serverinfo";
import { SETTINGS_FIELDS, type FieldId, applyFieldValue, fieldById } from "./settings-fields";
import {
  type AppliedLaunch,
  type AuthMode,
  INSTANCES_DIR,
  type Runtime,
  ROOT,
  type ServerInstance,
  type Settings,
  type State,
  type Visibility,
  defaultSettings,
  loadState,
  newInstance,
  record,
  selectedInstance,
  withState,
} from "./state";
import {
  WORKER_OPS,
  hostedEnv,
  isPidAlive,
  logDir,
  makeTapNames,
  readTail,
  stripAnsi,
  windowsArg,
  workerCommand,
  workerSpawnEnv,
} from "./tap";
import { dim, green, header, kv, red, yellow } from "./ui";
import { type VersionInfo, discoverVersions } from "./versions";
import * as win from "./win";
const EXE = "r5apex_ds.exe";

function findByNameOrVersion(name: string): VersionInfo | null {
  const versions = discoverVersions(ROOT);
  const exact = versions.find((v) => v.name === name);
  if (exact) return exact;
  const byVersion = versions.find((v) => v.version && v.version.join(".") === name.replace(/^v/, ""));
  return byVersion ?? null;
}

/**
 * 选中实例的运行记录。它是「记录」不是「事实」：进程可能已经死了，
 * 判定存活一律走 `win.getProcess`（调用方各自判，别在这里猜）。
 */
function runtimeOf(state: State): Runtime | null {
  return selectedInstance(state)?.runtime ?? null;
}

/** 端口：选中实例的设置端口；没有实例时用默认设置（主机页/体检页要一个可说的数）。 */
function portOf(state: State): number {
  return selectedInstance(state)?.settings.port ?? defaultSettings.port;
}

/** 实例记录里的进程还活着吗（`runtime` 有记录 ≠ 进程还在）。 */
function runtimeAlive(runtime: Runtime | null): boolean {
  return runtime !== null && runtime.pid > 0 && win.getProcess(runtime.pid) !== null;
}

/** 选中的实例；不存在就打印统一的错误。命令实现共用同一句文案。 */
function selectedOrComplain(state: State): ServerInstance | null {
  const instance = selectedInstance(state);
  if (instance !== null) return instance;
  console.log(red("  没有选中的实例。"));
  console.log(dim("  先在「服务器实例」页建一个（或选中已有的那个），再重试。"));
  return null;
}

export type StartOptions = {
  /**
   * 目标实例（id 或名字）。不给就用**选中的**实例 —— 面板只用选中项；
   * 显式给值是给计划任务/自启用的：它们不该依赖"现在选中了谁"。
   */
  instance?: string;
  port?: number;
  map?: string;
  playlist?: string;
  visibility?: Visibility;
  auth?: AuthMode;
  password?: string;
  hostname?: string;
  force?: boolean;
  /** false = plain console window (no pipe tap, no log file) */
  hosted?: boolean;
};

/** Wait for the log daemon's `READY <ctlPort>` line on its stdout pipe. */
async function waitForReady(
  stream: ReadableStream<Uint8Array> | undefined,
  timeoutMs: number,
): Promise<{ ready: boolean; ctlPort: number }> {
  if (!stream) return { ready: false, ctlPort: 0 };
  const reader = stream.getReader();
  const read = (async (): Promise<{ ready: boolean; ctlPort: number }> => {
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { ready: false, ctlPort: 0 };
      text += Buffer.from(value).toString("utf8");
      const match = /READY (\d+)/.exec(text);
      if (match) return { ready: true, ctlPort: Number.parseInt(match[1], 10) };
    }
  })();
  const settled = Promise.withResolvers<{ ready: boolean; ctlPort: number }>();
  const timer = setTimeout(() => settled.resolve({ ready: false, ctlPort: 0 }), timeoutMs);
  try {
    return await Promise.race([read, settled.promise]);
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      /* stream already settled */
    }
  }
}

/** 一次启动的设置：实例设置 + 本次命令行的单次覆盖（`--port` 这类不写回配置）。 */
function effectiveSettings(instance: ServerInstance, opts: StartOptions): Settings {
  const s = { ...instance.settings };
  if (opts.port !== undefined) s.port = opts.port;
  if (opts.map !== undefined) s.map = opts.map;
  if (opts.playlist !== undefined) s.playlist = opts.playlist;
  if (opts.visibility !== undefined) s.visibility = opts.visibility;
  if (opts.auth !== undefined) s.authMode = opts.auth;
  if (opts.password !== undefined) s.password = opts.password;
  if (opts.hostname !== undefined) s.hostname = opts.hostname;
  return s;
}

/**
 * 启动即进入的模式与地图：模板优先于实例设置。
 * 模板的 playlist/map 是「这份预设要用什么玩法」，设置里的值是可随手改的默认值。
 */
type LaunchTarget = {
  instance: ServerInstance;
  version: VersionInfo;
  template: ModeTemplate | null;
  /** 模板修订（`updatedAt`）：运行记录据此区分「进程带着哪一版模板起来的」 */
  templateRevision: string | null;
  /** 模板覆盖项（只含 `templateFields(playlist)` 声明、且值已归一的键） */
  overrides: Record<string, string>;
  settings: Settings;
  playlist: string;
  map: string;
};

function templateFor(state: State, instance: ServerInstance): ModeTemplate | null {
  if (instance.templateId === null) return null;
  return state.templates.find((template) => template.id === instance.templateId) ?? null;
}

/**
 * 模板覆盖项 → 「键 → 归一后的值」。解析 `templateCommands()` 的输出而不是自己重算：
 * 值的合法形式（整数范围、布尔 0/1）只有一个来源，startup 与运行期不可能给出两套值。
 */
function templateOverrides(template: ModeTemplate | null): Record<string, string> {
  if (template === null) return {};
  const overrides: Record<string, string> = {};
  for (const line of templateCommands(template)) {
    const match = /^playlist_override_set ([A-Za-z0-9_]+) (\S+)$/.exec(line);
    if (match === null) continue;
    overrides[match[1]] = match[2];
  }
  return overrides;
}

function launchTarget(state: State, instance: ServerInstance, version: VersionInfo, opts: StartOptions): LaunchTarget {
  const settings = effectiveSettings(instance, opts);
  const template = templateFor(state, instance);
  const playlist = template !== null && template.playlist.length > 0 ? template.playlist : settings.playlist;
  const map = template !== null && template.map.length > 0 ? template.map : settings.map;
  return {
    instance,
    version,
    template,
    templateRevision: template?.updatedAt ?? null,
    overrides: templateOverrides(template),
    settings,
    playlist,
    map,
  };
}

/**
 * `+hostip` 的取值：面板统一写成 `ip:端口`。
 *
 * 实测只写 IP 时引擎对外公布的端口不对（用户实测要求 ip:port），所以值里没带端口就补上
 * 本实例的游戏端口。留空 = 不传这一项，引擎用自测值（NAT 主机上那样会得到 `[::1]:0`）。
 */
export function hostipArgument(settings: Settings): string {
  const value = settings.hostip.trim();
  if (value.length === 0) return "";
  return value.includes(":") ? value : `${value}:${instancePorts(settings.port).game}`;
}

function buildArgs(s: Settings, playlist: string, map: string): string[] {
  const ports = instancePorts(s.port);
  const args = [
    "-dedicated",
    "-port",
    String(ports.game),
    // 一台机器上多个实例时，辅助端口必须各归各的：`hostport` 是对外公布的游戏端口，
    // `s2sPort` 是 S2S 通信口（引擎默认排在下一位），`clientport` 是客户端口。
    // 三个值都显式给出：默认端口族（37015/37016/37005）与引擎默认完全一致，所以单实例
    // 场景的行为一个字节都没变；非默认端口则不会再顶着 cfg 里的 37015 对外公布。
    "+hostport",
    String(ports.game),
    "+s2sPort",
    String(ports.s2s),
    "+clientport",
    String(ports.client),
    "-ansicolor",
    "-novid",
    "-wconsole",
    "+hostname",
    s.hostname,
    "+sv_allowSendTableTransmitToClients",
    "1",
    "+stringtable_compress",
    "1",
    "+spire_host_visibility",
    String(s.visibility),
    "+sv_onlineAuthMode",
    String(s.authMode),
    "+sv_quota_stringCmdsPerSecond",
    String(s.quotaString),
    "+sv_quota_scriptExecsPerSecond",
    String(s.quotaScript),
  ];
  if (s.visibility === 0) args.push("-offline", "+sv_onlineAuthEnable", "0");
  // 上报/探测用的公网地址：NAT 主机上引擎自测拿不到，不传就永远上不了架。
  const hostip = hostipArgument(s);
  if (hostip.length > 0) args.push("+hostip", hostip);
  if (s.password.length > 0) args.push("+sv_password", s.password);
  if (playlist.length > 0) args.push("+launchplaylist", playlist);
  if (map.length > 0) args.push("+map", map);
  // 1v1 对战统计外发开关：引擎自述 `fs_stats_url` 置空即关闭，值是空串。
  if (s.statsUpload === "off") args.push("+fs_stats_url", "");
  // 公告轮播：引擎 cvar 默认 0（一条都不发，实测 `help bridge_chat_announce` → def. "0"）。
  if (s.announceRotate === "on") args.push("+bridge_chat_announce", "1");
  if (s.extra.length > 0) args.push(...s.extra.split(/\s+/).filter(Boolean));
  return args;
}

function runningProcessesFor(engineDir: string): win.ProcInfo[] {
  const prefix = engineDir.toLowerCase().replace(/\\+$/, "");
  return win.findDediProcesses().filter((p) => p.path.toLowerCase().startsWith(prefix));
}

/**
 * Bun.spawn({detached}) hands back the pid of an intermediate process on
 * Windows, so readiness is detected the way the launcher does it: a new
 * process under the version directory that has the game port bound.
 */
async function waitForStarted(
  versionPath: string,
  port: number,
  before: Set<number>,
  timeoutMs = 30_000,
): Promise<{ proc: win.ProcInfo | null; bound: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let candidate: win.ProcInfo | null = null;
  for (;;) {
    const fresh = runningProcessesFor(versionPath).filter((p) => !before.has(p.pid));
    if (fresh.length > 0) {
      candidate = fresh.toSorted((a, b) => b.pid - a.pid)[0];
      const ports = win.udpEndpoints(candidate.pid);
      if (ports.some((ep) => ep.endsWith(`:${port}`))) return { proc: candidate, bound: true };
    }
    if (Date.now() >= deadline) return { proc: candidate, bound: false };
    await Bun.sleep(1500);
  }
}

// ------------------------------------------------------------ log shards

export type LogShard = { name: string; path: string; size: number; mtime: number; current: boolean };

/** 两位补零（文件名时间戳的每一段）。 */
const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * `logs/<版本>-<端口>-<YYYYMMDD-HHMMSS>.log`（本地时间）。
 * 文件名即时间序：实测同一个 `版本-端口` 的旧日志跨启动追加过 8 次启动横幅，
 * 面板会拿上一次运行的内容当现在 —— 所以一次运行一个分片。
 */
function logShardName(version: string, port: number, at: Date): string {
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${version}-${port}-${stamp}.log`;
}

/** 全部分片（最新在前，按修改时间；含旧命名的遗留文件）。 */
export function listLogShards(currentPath: string | undefined): LogShard[] {
  const dir = join(ROOT, "logs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".log"))
    .map((name) => {
      const path = join(dir, name);
      const stats = statSync(path);
      return { name, path, size: stats.size, mtime: stats.mtimeMs, current: path === currentPath };
    })
    .toSorted((a, b) => b.mtime - a.mtime);
}

/**
 * 只保留最新 `keep` 个分片（按**文件名字典序**= 时间序）；删除失败只告警。
 *
 * `prefix` 限定「哪个实例的分片」（`<版本>-<端口>-`）：`logs/` 是所有实例共用的，
 * 按全局列表清理会把别的实例正在写的文件也删掉。
 */
function pruneLogShards(keep: number, keepPath: string, prefix: string): string[] {
  const byName = listLogShards(keepPath)
    .filter((shard) => shard.name.startsWith(prefix))
    .toSorted((a, b) => (a.name < b.name ? -1 : 1));
  const survivors = new Set(byName.slice(-Math.max(0, keep)).map((shard) => shard.path));
  const failed: string[] = [];
  for (const shard of byName) {
    if (survivors.has(shard.path)) continue;
    try {
      rmSync(shard.path);
    } catch {
      failed.push(shard.name);
    }
  }
  return failed;
}

export type StartOutcome =
  | { ok: false; error: string; hint?: string }
  | {
      ok: true;
      /** 哪个实例起来的（面板要能说出来） */
      instanceId: string;
      instanceName: string;
      version: string;
      /** 这个实例自己的引擎工作副本 —— 进程真正运行/写日志的那个目录 */
      versionPath: string;
      pid: number;
      port: number;
      workingSetMB: number;
      privateMB: number;
      endpoints: string[];
      title: string;
      settings: Settings;
      /** 启动参数里真正下发的模式 / 地图（模板优先于实例设置） */
      playlist: string;
      map: string;
      logFile?: string;
      hosted: boolean;
      bound: boolean;
      /** 启动前为「面板值优先于 cfg」重写过的 cvar 行 */
      synced: CfgSync[];
      /** 启动时写进实例 playlist 文件、确实生效的模板覆盖（键 → 值） */
      appliedOverrides: Record<string, string>;
      /** 不致命但要说出来的事（守护没起来、旧分片删不掉…） */
      warnings: string[];
    };

/** 启动/停止的目标实例：显式选择器优先，否则用选中的那个。 */
function targetInstance(state: State, selector: string | undefined): ServerInstance | null {
  if (selector === undefined) return selectedInstance(state);
  return findInstance(state, selector);
}

/**
 * 启动**目标实例**并返回结果；`report` 只收进度行（面板传空，command 形态打印）。
 *
 * 前置条件一律**明确报错**，不替用户猜：没选实例、实例没选版本、同一个实例已经在跑
 * （`--force` 也不放行 —— 两个引擎抢同一个端口和日志只会互相毁）、端口被别的实例占着。
 * 真正会跑一次的流程在 `launchInstance()` 里，全程持有该实例的启动锁。
 * 目标实例默认是选中的那个，也可以由 `opts.instance` 显式指定（计划任务 / 自启）。
 */
export async function startInstance(
  state: State,
  opts: StartOptions,
  report: (line: string) => void = () => {},
): Promise<StartOutcome> {
  const instance = targetInstance(state, opts.instance);
  if (instance === null) {
    return {
      ok: false,
      error: opts.instance === undefined ? "没有选中的实例。" : `找不到实例「${opts.instance}」。`,
      hint: "先在「服务器实例」页建一个（或选中已有的那个），再重试。",
    };
  }
  const version = releaseVersion(instance.version);
  if (version === null) {
    return {
      ok: false,
      error: `实例「${instance.name}」还没有选版本（或者选的版本目录已经不在了）。`,
      hint: "先在「服务端版本」页装好一个版本，再在「服务器实例」页给这个实例选上它。",
    };
  }
  const lock = acquireStartLock(instance.id);
  if (!lock.ok) return { ok: false, error: lock.error, hint: "另一个启动流程还没结束；等它结束后再试。" };
  try {
    return await launchInstance(state, instance, version, opts, report);
  } finally {
    lock.release();
  }
}

/**
 * 启动时把模板的 playlist 参数写进实例私有的 playlist 文件。
 *
 * 写的是**完整的一张表**，不是"只写模板设了的那几项"：
 *  - 模板设了值的键 → 用模板值；
 *  - 该玩法声明过、但模板没设值的键 → 回到**发布基线**（从只读安装目录读）。
 *
 * 第二半是关键：每个实例的 playlist 文件是私有的、跨启动留存的。只写不还原的话，
 * "模板里删掉一个覆盖项"永远不会生效 —— 旧值会一直躺在文件里。同理，**换玩法**时
 * 还要把上一版启动用过的那个玩法的声明键也还原回基线（否则切回旧玩法时旧值还在）。
 *
 * 返回真正写下去的键值，以及"模板要求了、但该玩法的声明行里没有这个键"的键
 * （后者不能算应用成功）。
 */
function applyTemplateAtStartup(
  engineDir: string,
  releasePath: string,
  target: LaunchTarget,
  previousPlaylist: string,
  warnings: string[],
): { overrides: Record<string, string>; missing: string[] } {
  const path = join(engineDir, PLAYLIST_FILE);
  const overrides: Record<string, string> = {};
  const missing: string[] = [];

  /** 一个玩法的声明键：模板值优先，其余回到发布基线。 */
  const syncPlaylist = (playlist: string, templateValues: Record<string, string>): void => {
    if (playlist.length === 0) return;
    const keys = templateFields(playlist).map((field) => field.key);
    if (keys.length === 0) return;
    const baseline = playlistBaseline(releasePath, playlist, keys);
    const wanted: Record<string, string> = {};
    for (const key of keys) {
      const value = templateValues[key] ?? baseline[key];
      if (value !== undefined) wanted[key] = value;
    }
    const result = applyPlaylistOverrides(path, playlist, wanted);
    if (result.error !== null) {
      warnings.push(`playlist 文件没写成（${playlist}）：${result.error}`);
      return;
    }
    for (const [key, value] of Object.entries(wanted)) {
      if (result.missing.includes(key)) {
        if (templateValues[key] !== undefined) missing.push(key);
        continue;
      }
      if (templateValues[key] !== undefined) overrides[key] = value;
    }
  };

  // 换过玩法：先把上一版启动用过的玩法的声明键还原回基线。
  if (previousPlaylist.length > 0 && previousPlaylist !== target.playlist) {
    syncPlaylist(previousPlaylist, {});
  }
  syncPlaylist(target.playlist, target.overrides);
  return { overrides, missing };
}

/** 一次真实或模拟的启动：前置条件已由 `startInstance()` 检查过，这里只管把它跑起来。 */
async function launchInstance(
  state: State,
  instance: ServerInstance,
  version: VersionInfo,
  opts: StartOptions,
  report: (line: string) => void,
): Promise<StartOutcome> {
  const target = launchTarget(state, instance, version, opts);
  const warnings: string[] = [];

  // 同一个实例绝不重复启动：`--force` 也不放行。
  if (runtimeAlive(instance.runtime)) {
    return {
      ok: false,
      error: `实例「${instance.name}」已经在运行（pid ${instance.runtime?.pid}）。`,
      hint: "要重启就用面板上的「重启」；强制启动也不会让同一个实例再开一个进程。",
    };
  }
  if (instance.runtime !== null) {
    warnings.push(`旧运行记录（pid ${instance.runtime.pid}）的进程已经不在了，按全新启动处理。`);
  }
  // 端口互斥：别的实例（本工具自己起的）占着同一个端口时，只有改端口这一条路。
  const occupant = state.instances.find(
    (other) =>
      other.id !== instance.id &&
      other.runtime !== null &&
      other.runtime.port === target.settings.port &&
      runtimeAlive(other.runtime),
  );
  if (occupant !== undefined) {
    return {
      ok: false,
      error: `UDP ${target.settings.port} 已经被实例「${occupant.name}」占用。`,
      hint: "在「服务器实例」页给这个实例换一个端口（新建实例时不指定端口会自动挑一个空闲的）。",
    };
  }
  if (win.portInUse(target.settings.port) && !opts.force) {
    return {
      ok: false,
      error: `UDP ${target.settings.port} 已被占用（不是本工具启动的实例）。`,
      hint: "换一个端口，或在面板上确认后强制启动（force）。",
    };
  }

  // 实例自己的可写引擎目录：配置与日志隔离的唯一手段。
  const workspace = await ensureWorkspace(instance, version, report);
  if (!workspace.ok) return { ok: false, error: workspace.error, hint: workspace.hint };
  const engineDir = workspace.dir;
  if (workspace.copied) {
    warnings.push(`已为实例建立引擎工作副本：${engineDir}（每个实例一份可写副本，配置与日志才不会互相覆盖）`);
  }
  if (workspace.replacedVersion !== null) {
    warnings.push(`工作副本原先属于 ${workspace.replacedVersion}，已按当前版本 ${version.name} 重建。`);
  }
  if (workspace.carried.length > 0) {
    warnings.push(`换副本时带过来了：${workspace.carried.join("、")}（引擎自写 / 运营者手写的数据）`);
  }
  for (const line of workspace.warnings) warnings.push(line);

  const templateApply = applyTemplateAtStartup(
    engineDir,
    version.path,
    target,
    instance.runtime?.applied?.playlist ?? "",
    warnings,
  );
  for (const key of templateApply.missing) {
    warnings.push(
      `模板的 ${key} 在玩法 ${target.playlist} 里没有声明行 → 启动时不生效（在「游戏模式模板」页可以运行期下发覆盖）`,
    );
  }
  // 启动快照**每次都记**：它是"这个进程实际带着什么起来的"的唯一凭据，没有模板也要有
  // （否则界面上永远分不清"设置改了没重启"和"记录里没这一项"）。
  const applied: AppliedLaunch = {
    settings: { ...target.settings },
    templateId: target.template?.id ?? null,
    // 只有整份模板都落地了才记修订号：缺键时留 null，界面上就是"没完全生效"。
    templateRevision: target.template !== null && templateApply.missing.length === 0 ? target.templateRevision : null,
    playlist: target.playlist,
    map: target.map,
    overrides: templateApply.overrides,
    templateMissing: templateApply.missing,
    at: new Date().toISOString(),
  };

  const synced = syncLaunchSettings(engineDir, target.settings);
  if (DEV_MODE) {
    return await startDevInstance(state, instance, engineDir, target, applied, synced, opts, report, warnings);
  }

  const exePath = join(engineDir, EXE);
  if (!existsSync(exePath)) {
    return {
      ok: false,
      error: `实例工作副本里没有 ${EXE}：${exePath}`,
      hint: `删掉工作副本让它重新复制：删除 ${workspaceDir(instance.id)} 后重试。`,
    };
  }
  const args = buildArgs(target.settings, target.playlist, target.map);
  const env = { ...process.env, VPROJECT: "1", FROM_R5F_LAUNCHER: "1" } as Record<string, string>;

  let logdPid: number | undefined;
  let logFile: string | undefined;
  let tapPidFile: string | undefined;
  let ctlPortValue = 0;
  let ctlTokenValue = "";
  if (opts.hosted !== false) {
    logDir(ROOT);
    const names = makeTapNames();
    const candidateLog = join(logDir(ROOT), logShardName(version.name, target.settings.port, new Date()));
    const pidFile = join(logDir(ROOT), `.tap-${names.id}.pid`);
    const ctlToken = randomUUID().replace(/-/g, "");
    // 日志守护是个**独立进程**：面板退出后它还得继续把引擎输出写进日志分片。
    // 它以一整条 argv 重新进入内部 worker（打包时是 exe 自己 + `--worker`）。
    const daemon = Bun.spawn({
      cmd: workerCommand([
        WORKER_OPS.logDaemon,
        "--out-pipe",
        names.outPipe,
        "--in-pipe",
        names.inPipe,
        "--log",
        candidateLog,
        "--pid-file",
        pidFile,
        "--ctl-port",
        "0",
        "--ctl-token",
        ctlToken,
        "--root",
        ROOT,
      ]),
      cwd: ROOT,
      env: workerSpawnEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      detached: true,
    });
    const { ready, ctlPort } = await waitForReady(daemon.stdout, 8000);
    if (ready) {
      Object.assign(env, hostedEnv(names));
      logdPid = daemon.pid;
      tapPidFile = pidFile;
      logFile = candidateLog;
      ctlTokenValue = ctlToken;
      ctlPortValue = ctlPort;
      report("已启用托管控制台（日志会写入文件，面板的日志页可以实时跟随）");
      // 保留最近 N 次运行的分片（`logRetention` 是本机工具设置，不传给引擎）。
      // 只清本实例这个「版本-端口」前缀的分片：多实例共用 logs/，按全局列表清理
      // 会把别的实例正在写的文件也删掉。
      const failed = pruneLogShards(
        Math.max(1, target.settings.logRetention ?? 10),
        candidateLog,
        `${version.name}-${target.settings.port}-`,
      );
      if (failed.length > 0) warnings.push(`旧日志分片删除失败（不影响启动）：${failed.join(", ")}`);
    } else {
      warnings.push("日志守护未能就绪，本次退回普通控制台模式（日志只在引擎窗口里）。");
      try {
        daemon.kill();
      } catch {
        /* already gone */
      }
    }
    daemon.unref();
  }

  const before = new Set(win.findDediProcesses().map((p) => p.pid));
  const child = Bun.spawn({
    cmd: [exePath, ...args],
    cwd: engineDir,
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();

  report("等待实例就绪（加载地图通常 10-30 秒）...");
  const { proc, bound } = await waitForStarted(engineDir, target.settings.port, before);
  if (!proc) {
    return {
      ok: false,
      error: "30 秒内没有出现服务端进程。",
      hint: "排查：三件套是否齐全（在「开服检查清单」页跑一遍体检）、端口是否被占、杀软是否拦截 loader.dll。",
    };
  }
  instance.runtime = {
    pid: proc.pid,
    port: target.settings.port,
    version: version.name,
    startedAt: new Date().toISOString(),
    engineDir,
    exePath,
    logdPid,
    logFile,
    ctlPort: ctlPortValue || undefined,
    ctlToken: ctlTokenValue || undefined,
    applied,
  };
  instance.updatedAt = new Date().toISOString();
  // 只把**这次启动的运行时记录**合并回去：启动要等几十秒，这期间别的进程写的状态
  // （另一个实例的运行记录、面板的一次改名）必须原样保留，不能被整份覆盖。
  withState(state, (disk) => {
    const live = disk.instances.find((entry) => entry.id === instance.id);
    if (live !== undefined) {
      live.runtime = instance.runtime;
      live.updatedAt = instance.updatedAt;
    }
    // `start` overrides are one-shot: the README promises 单次覆盖（不写回配置）,
    // and `settings` is the surface that persists.
    record(
      disk,
      "start",
      `${instance.name} ${version.name} port=${target.settings.port} map=${target.map} hosted=${Boolean(logFile)}`,
    );
  });
  if (tapPidFile) {
    await Bun.write(tapPidFile, String(proc.pid));
  }

  return {
    ok: true,
    instanceId: instance.id,
    instanceName: instance.name,
    version: version.name,
    versionPath: engineDir,
    pid: proc.pid,
    port: target.settings.port,
    workingSetMB: proc.workingSetMB,
    privateMB: proc.privateMB,
    endpoints: win.udpEndpoints(proc.pid),
    title: proc.title,
    settings: target.settings,
    playlist: target.playlist,
    map: target.map,
    logFile,
    hosted: Boolean(logFile),
    bound,
    synced,
    appliedOverrides: applied.overrides,
    warnings,
  };
}

/**
 * 开发模式（R5F_DEV=1）的启动：拉起本机模拟引擎（隐藏命令 `__dev-engine`），
 * 返回与真实路径**同形**的 `StartOutcome`。
 *
 * 与真实路径的差别只有「子进程是谁」：工作副本、设置同步、runtime 记录、日志分片与
 * 保留策略都复用同一批 helper，所以面板看到的数据形状不变。两处刻意的不同：
 *  - 模拟引擎**自己**就是日志写入方（不再另起 `__logd`），因此不设 `runtime.logdPid`；
 *  - 模拟引擎不绑真实端口，进程事实来自它自己写的实例快照（一实例一份）。
 */
async function startDevInstance(
  state: State,
  instance: ServerInstance,
  engineDir: string,
  target: LaunchTarget,
  applied: AppliedLaunch,
  synced: CfgSync[],
  opts: StartOptions,
  report: (line: string) => void,
  warnings: string[],
): Promise<StartOutcome> {
  if (opts.hosted === false) {
    return {
      ok: false,
      error: "开发模拟不支持 --no-host。",
      hint: "去掉 --no-host：模拟引擎本身就是托管控制台（日志 + 命令回执都走它）。",
    };
  }
  warnings.unshift("开发模式（R5F_DEV=1）：本机模拟实例，没有真实游戏端口，也没有对外连接。");

  logDir(ROOT);
  const logFile = join(logDir(ROOT), logShardName(target.version.name, target.settings.port, new Date()));
  const ctlToken = randomUUID().replace(/-/g, "");
  // 引擎的 stderr 写进沙箱文件，而不是继承本进程的 stderr：模拟引擎比拉起它的
  // 面板活得久，继承出去的 fd 会让调用方的 `stdout/stderr` 管道永远等不到 EOF
  // （面板的 runWorker 就会卡死）。文件里的最后几行就是启动失败的原因。
  const errLog = join(ROOT, "dev-engine.stderr.log");
  const errFd = openSync(errLog, "a");

  let child: Bun.Subprocess<"ignore", "pipe", number>;
  try {
    child = Bun.spawn({
      cmd: workerCommand([
        WORKER_OPS.devEngine,
        "--instance",
        instance.id,
        "--version-path",
        engineDir,
        "--settings",
        JSON.stringify(target.settings),
        "--log",
        logFile,
        "--ctl-token",
        ctlToken,
      ]),
      cwd: ROOT,
      env: workerSpawnEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: errFd,
      detached: true,
    });
  } finally {
    closeSync(errFd); // 子进程自己有那份 fd
  }
  const { ready, ctlPort } = await waitForReady(child.stdout, 8000);
  if (!ready || ctlPort <= 0) {
    // 刚 spawn 出来的子进程：pid 是我们自己的，kill 它是安全的（不是快照里那个可能被复用的 pid）。
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    await child.exited;
    return {
      ok: false,
      error: "模拟引擎没有在 8 秒内就绪。",
      hint: `引擎自己的报错在 ${errLog}；确认沙箱目录可写、端口未被占用，然后重试。`,
    };
  }
  child.unref();

  report("等待模拟实例就绪（本机进程，几乎立即）...");
  // 模拟引擎在说 READY **之前**就写好了快照（dev-engine 的顺序契约），所以这里按
  // 我们刚 spawn 的 pid 直接读它的进程事实 —— 比"在版本目录下找新进程"更精确，
  // 也不受路径符号链接影响。
  const proc = win.getProcess(child.pid);
  if (!proc) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    await child.exited;
    return {
      ok: false,
      error: "模拟引擎已就绪，但实例快照读不出来（无 pid/端口，无法安全管理）。",
      hint: `检查沙箱快照目录 ${devEngineSnapshotDir()} 是否可写、快照里是否有 ${instance.id}.json。`,
    };
  }
  const endpoints = win.udpEndpoints(proc.pid);
  const bound = endpoints.some((endpoint) => endpoint.endsWith(`:${target.settings.port}`));

  const previousRuntime = instance.runtime;
  const previousHistory = state.history.slice();
  instance.runtime = {
    pid: proc.pid,
    port: target.settings.port,
    version: target.version.name,
    startedAt: new Date().toISOString(),
    engineDir,
    exePath: join(engineDir, EXE),
    // 模拟引擎自己写日志：不设 logdPid，停止路径才不会把它当成第二个进程再杀一次。
    logFile,
    ctlPort,
    ctlToken,
    applied,
  };
  instance.updatedAt = new Date().toISOString();
  try {
    withState(state, (disk) => {
      const live = disk.instances.find((entry) => entry.id === instance.id);
      if (live !== undefined) {
        live.runtime = instance.runtime;
        live.updatedAt = instance.updatedAt;
      }
      record(
        disk,
        "start",
        `[模拟] ${instance.name} ${target.version.name} port=${target.settings.port} map=${target.map} hosted=true`,
      );
    });
  } catch (err) {
    child.kill();
    await child.exited;
    instance.runtime = previousRuntime;
    state.history = previousHistory;
    return { ok: false, error: `无法保存模拟实例：${err instanceof Error ? err.message : String(err)}` };
  }
  // 保留最近 N 次运行的分片（`logRetention` 是本机工具设置，不传给引擎）。
  const failed = pruneLogShards(
    Math.max(1, target.settings.logRetention ?? 10),
    logFile,
    `${target.version.name}-${target.settings.port}-`,
  );
  if (failed.length > 0) warnings.push(`旧日志分片删除失败（不影响启动）：${failed.join(", ")}`);

  return {
    ok: true,
    instanceId: instance.id,
    instanceName: instance.name,
    version: target.version.name,
    versionPath: engineDir,
    pid: proc.pid,
    port: target.settings.port,
    workingSetMB: proc.workingSetMB,
    privateMB: proc.privateMB,
    endpoints,
    title: proc.title,
    settings: target.settings,
    playlist: target.playlist,
    map: target.map,
    logFile,
    hosted: true,
    bound,
    synced,
    appliedOverrides: applied.overrides,
    warnings,
  };
}

export async function cmdStart(state: State, opts: StartOptions): Promise<number> {
  const result = await startInstance(state, opts, (line) => console.log(dim(line)));
  if (!result.ok) {
    console.log(red(result.error));
    if (result.hint) console.log(dim(`  ${result.hint}`));
    return 1;
  }

  header(`启动 ${result.instanceName} · ${result.version}`);
  kv("端口", `UDP ${result.port}`);
  kv("地图", result.map || "(未指定)");
  kv("模式", result.playlist || "(启动后由玩家选择)");
  kv("可见性", `${result.settings.visibility}  (0=离线 1=隐藏 2=公开)`);
  kv("认证", `sv_onlineAuthMode ${result.settings.authMode}`);
  kv("名称", result.settings.hostname);
  kv("引擎目录", result.versionPath);
  for (const warning of result.warnings) console.log(yellow(`  ${warning}`));
  for (const change of result.synced) {
    console.log(
      dim(`  已同步 ${change.file}: ${change.cvar} ${change.from} → "${change.to}"（否则 cfg 会覆盖面板设置）`),
    );
  }
  for (const [key, value] of Object.entries(result.appliedOverrides)) {
    console.log(dim(`  模板已写入 ${key} = ${value}（实例自己的 playlist 文件，只改已存在的行）`));
  }
  if (result.logFile) kv("本次日志", result.logFile);
  console.log(green(`\n已启动：pid ${result.pid}${DEV_MODE ? "（模拟）" : ""}`));
  kv("内存", `${result.workingSetMB} MB 工作集 / ${result.privateMB} MB 私有提交`);
  kv("监听 UDP", result.endpoints.join(", "));
  if (result.title) kv("窗口标题", result.title);
  if (!result.bound) {
    console.log(yellow(`  注意：进程在跑但 30 秒内没看到 UDP ${result.port} 绑定，稍后在「运行中」页复查。`));
  }
  if (DEV_MODE) {
    kv("模拟沙箱", ROOT);
    console.log(dim("  控制台 / 玩家 / 封禁全是本机模拟数据；没有真玩家能连进来。"));
  } else {
    console.log(dim(`  玩家加入：R5F launcher -> connect <公网IP>:${result.port}`));
  }
  return 0;
}

/**
 * 停止结果。`error` 非空表示实例**没有确认停止**：此时 runtime 记录保留（旧实例
 * 仍然可停），调用方必须把它说出来 —— 悄悄清掉 runtime 会让面板失去"还能再停一次"
 * 的能力。
 */
export type StopResult = { killed: number; error?: string };

/**
 * 停掉**一个**实例：进程树 + 日志守护。
 *
 * 「记录里的 pid」不等于「还活着的进程」：进程已经不在时先清掉记录里的死 pid（不算
 * 失败），只对真的还活着的进程动手。留下的 `error` 表示**没有确认停止** —— 此时
 * 运行记录必须保留，面板才有"再停一次"的机会。
 */
function stopOneInstance(state: State, instance: ServerInstance, handled: Set<number>): StopResult {
  const runtime = instance.runtime;
  if (runtime === null) return { killed: 0 };
  const enginePid = runtime.pid;
  if (enginePid <= 0 || win.getProcess(enginePid) === null) {
    // 进程已经不在：记录留着只会让面板以为它还在跑。清掉，但不谎报"停掉了"。
    const stale = state.instances.find((entry) => entry.id === instance.id);
    if (stale) {
      stale.runtime = null;
      stale.updatedAt = new Date().toISOString();
    }
    return { killed: 0 };
  }
  let killed = 0;
  let error: string | undefined;
  if (handled.has(enginePid)) {
    error = `pid ${enginePid} 已经处理过（同一个进程不属于两个实例），本次跳过。`;
  } else {
    handled.add(enginePid);
    // 开发模式下 `win.killTree` 走 `stopDevEngine`：起一个隐藏的 `__dev-stop <pid>`
    // 子进程让模拟引擎**自己**收尾，绝不对可能已被系统复用的 OS pid 发信号。
    if (win.killTree(enginePid)) {
      killed += 1;
    } else {
      error = DEV_MODE
        ? `模拟引擎没有确认停止（pid ${enginePid}）。实例记录已保留，可以重试 stop。`
        : `实例进程没有确认停止（pid ${enginePid}）。实例记录已保留，可以重试 stop。`;
    }
  }

  const logd = runtime.logdPid ?? 0;
  // 模拟引擎自己就是日志守护（启动时不设 logdPid）；开发模式下也绝不 `process.kill`
  // 记录里的 pid —— 那个 pid 与我们无关，可能是别的进程。
  if (!DEV_MODE && logd > 0 && logd !== enginePid && !handled.has(logd) && isPidAlive(logd)) {
    try {
      process.kill(logd);
      handled.add(logd);
      killed += 1;
    } catch {
      /* already gone */
    }
  }

  if (error !== undefined) return { killed, error };
  const live = state.instances.find((entry) => entry.id === instance.id);
  if (live) {
    live.runtime = null;
    live.updatedAt = new Date().toISOString();
  }
  return { killed };
}

export type StopOptions = { all?: boolean; instance?: string };

/**
 * 停掉实例：默认只停**目标**那个（`instance` 指定，或选中的那个）；`all` 停掉所有
 * 「记录里有活进程」的实例。
 *
 * `all` 是**按记录**逐个停的，不是"把根目录下的 r5apex_ds 全杀掉"：后者会顺手杀掉
 * 运维自己手动起的进程，也会杀掉不在我们记录里的实例 —— 那种"全杀"没有回执可言。
 */
export function stopInstance(state: State, opts: StopOptions = {}): StopResult {
  const targets: ServerInstance[] = [];
  if (opts.all) {
    targets.push(...state.instances.filter((instance) => instance.runtime !== null));
  } else {
    const instance = targetInstance(state, opts.instance);
    if (instance === null) {
      return {
        killed: 0,
        error: opts.instance === undefined ? "没有选中的实例。" : `找不到实例「${opts.instance}」。`,
      };
    }
    targets.push(instance);
  }
  let killed = 0;
  const failures: string[] = [];
  const handled = new Set<number>();
  for (const instance of targets) {
    const result = stopOneInstance(state, instance, handled);
    killed += result.killed;
    if (result.error !== undefined) failures.push(`「${instance.name}」：${result.error}`);
  }
  const cleared = targets.filter((instance) => instance.runtime === null).map((instance) => instance.id);
  if (failures.length > 0) {
    const error = failures.join("；");
    withState(state, (disk) => {
      for (const id of cleared) dropRuntime(disk, id);
      record(disk, "stop", `failed: ${error}`);
    });
    return { killed, error };
  }
  withState(state, (disk) => {
    for (const id of cleared) dropRuntime(disk, id);
    if (killed > 0) record(disk, "stop", `killed=${killed}`);
  });
  return { killed };
}

/** 把某个实例的运行记录清掉（只动这一个实例）。 */
function dropRuntime(state: State, id: string): void {
  const instance = state.instances.find((entry) => entry.id === id);
  if (instance === undefined) return;
  instance.runtime = null;
  instance.updatedAt = new Date().toISOString();
}

// ------------------------------------------------------------------ 实例管理

/** 实例名规则（创建/改名共用）：非空、≤40 字、不重名。 */
function assertInstanceName(state: State, name: string, self: ServerInstance | null = null): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("实例名不能为空");
  if (trimmed.length > 40) throw new Error(`实例名最长 40 个字符（当前 ${trimmed.length} 个）`);
  const clash = state.instances.find((instance) => instance.name === trimmed && instance !== self);
  if (clash !== undefined) throw new Error(`已经有叫「${trimmed}」的实例`);
  return trimmed;
}

/**
 * 端口族冲突检查：候选端口的三件套（游戏 / S2S / 客户端）不能和别的实例的端口族重叠。
 * 返回冲突的实例（没有就是 null）。
 */
function portFamilyClash(state: State, port: number, self: ServerInstance | null): ServerInstance | null {
  const wanted = new Set(portFamily(port));
  return (
    state.instances.find(
      (instance) => instance !== self && portFamily(instance.settings.port).some((entry) => wanted.has(entry)),
    ) ?? null
  );
}

/** 端口必须合法：范围对、家族不撞、系统上没有真的被占。返回错误文本（合法时 null）。 */
function portProblem(state: State, port: number, self: ServerInstance | null): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535 - 2) {
    return `端口不合法：${port}（1–65533，后面两个端口给 S2S / 客户端用）`;
  }
  // 端口没变就不必再探测：正在跑的实例本来就占用着自己的端口。
  if (self !== null && self.settings.port === port) return null;
  const clash = portFamilyClash(state, port, self);
  if (clash !== null) {
    return `UDP ${port}（及其后两个端口）与实例「${clash.name}」的 ${clash.settings.port} 撞车`;
  }
  const busy = portFamily(port).find((entry) => win.portInUse(entry));
  if (busy !== undefined) return `UDP ${busy} 已经被系统上别的进程占用`;
  return null;
}

/**
 * 新建实例：名字 + 版本 + 启动设置（+ 可选模板）。
 *
 * 端口：**显式给了就照给的办** —— 撞车/被占就报错，绝不悄悄换一个（用户指了端口就是
 * 指了端口）。没给才用 `nextFreePort` 自动挑一个空闲的。实例只是记录，不会立刻复制引擎
 * 目录（那一步在启动时做，见 `instances.ts`）。
 */
export function createServerInstance(
  state: State,
  input: { name: string; version: string | null; templateId?: string | null; settings?: Settings; port?: number },
): ServerInstance {
  return withState(state, (disk) => createInstance(disk, input));
}

/** 新建实例的实际改动（在传进来的那份状态上校验 + 生效）。 */
function createInstance(
  state: State,
  input: { name: string; version: string | null; templateId?: string | null; settings?: Settings; port?: number },
): ServerInstance {
  const name = assertInstanceName(state, input.name);
  if (input.version !== null && findByNameOrVersion(input.version) === null) {
    throw new Error(`找不到版本目录「${input.version}」（在「服务端版本」页可以看到已安装的版本）`);
  }
  if (
    input.templateId !== undefined &&
    input.templateId !== null &&
    !state.templates.some((t) => t.id === input.templateId)
  ) {
    throw new Error(`找不到模式模板「${input.templateId}」`);
  }
  const base = input.settings ?? defaultSettings;
  let port: number;
  if (input.port !== undefined) {
    const problem = portProblem(state, Math.trunc(input.port), null);
    if (problem !== null) throw new Error(problem);
    port = Math.trunc(input.port);
  } else {
    port = nextFreePort(state, base.port);
    if (port === 0) {
      throw new Error(`没有可用的 UDP 端口（从 ${base.port} 起找了 500 个都被占用）`);
    }
  }
  const instance: ServerInstance = {
    ...newInstance(name, { ...base, port }),
    version: input.version,
    templateId: input.templateId ?? null,
  };
  state.instances.push(instance);
  record(state, "instance create", `${name} version=${input.version ?? "none"} port=${port}`);
  return instance;
}

/**
 * 改实例：名字 / 版本 / 模板 / 整份设置（省略的字段不动）。
 *
 * **先全部校验、再一次性改**：半改的状态（名字改了、版本没改）会留在内存里，下一次
 * 谁保存一下就把半截状态写进文件了。
 */
export function updateServerInstance(
  state: State,
  id: string,
  patch: { name?: string; version?: string | null; templateId?: string | null; settings?: Settings },
): ServerInstance {
  return withState(state, (disk) => updateInstance(disk, id, patch));
}

/** 改实例的实际改动（先全部校验、再一次性生效）。 */
function updateInstance(
  state: State,
  id: string,
  patch: { name?: string; version?: string | null; templateId?: string | null; settings?: Settings },
): ServerInstance {
  const instance = state.instances.find((entry) => entry.id === id);
  if (instance === undefined) throw new Error(`找不到实例「${id}」`);
  const name = patch.name === undefined ? instance.name : assertInstanceName(state, patch.name, instance);
  if (patch.version !== undefined && patch.version !== null && findByNameOrVersion(patch.version) === null) {
    throw new Error(`找不到版本目录「${patch.version}」`);
  }
  if (
    patch.templateId !== undefined &&
    patch.templateId !== null &&
    !state.templates.some((t) => t.id === patch.templateId)
  ) {
    throw new Error(`找不到模式模板「${patch.templateId}」`);
  }
  let settings: Settings | undefined;
  if (patch.settings !== undefined) {
    const port = Math.trunc(patch.settings.port);
    const problem = portProblem(state, port, instance);
    if (problem !== null) throw new Error(problem);
    settings = { ...patch.settings, port };
  }
  instance.name = name;
  if (patch.version !== undefined) instance.version = patch.version;
  if (patch.templateId !== undefined) instance.templateId = patch.templateId;
  if (settings !== undefined) instance.settings = settings;
  instance.updatedAt = new Date().toISOString();
  record(state, "instance update", instance.name);
  return instance;
}

/** 复制实例的**配置**（名字 / 版本 / 设置 / 模板），端口重新挑一个空闲的；不带运行记录。 */
export function copyServerInstance(state: State, id: string): ServerInstance {
  return withState(state, (disk) => copyInstance(disk, id));
}

function copyInstance(state: State, id: string): ServerInstance {
  const source = state.instances.find((entry) => entry.id === id);
  if (source === undefined) throw new Error(`找不到实例「${id}」`);
  let name = `${source.name} 副本`;
  for (let serial = 2; state.instances.some((instance) => instance.name === name); serial += 1) {
    name = `${source.name} 副本 ${serial}`;
  }
  // 端口故意不显式指定：副本要的是"另一组空闲端口"，不是原样照抄。
  const instance = createInstance(state, {
    name,
    version: source.version,
    templateId: source.templateId,
    settings: source.settings,
  });
  record(state, "instance copy", `${source.name} -> ${instance.name}`);
  return instance;
}

/**
 * 删实例并**等引擎工作副本真的清掉**（删除路径用这个：进程可能马上就退出，
 * 后台清理来不及跑完）。失败如实抛出（记录已经删了，所以错误文本会说清这一点）。
 */
export async function deleteServerInstanceAndWait(state: State, id: string): Promise<void> {
  const name = withState(state, (disk) => deleteInstance(disk, id));
  const failed = await removeWorkspace(id);
  if (failed.length > 0) {
    throw new Error(`实例「${name}」已删除，但引擎工作副本没删掉：${failed.join("；")}`);
  }
}

/**
 * 删除实例。**运行中不接受删除**（先 stop）：正在跑的引擎还占着端口、还在写它的工作副本，
 * 删掉记录只会让那个进程变成没人认领的孤儿。
 *
 * 面板用的是这个同步版本：记录立刻删掉（界面上的"删掉了"），4.5 GB 级的工作副本清理
 * 扔到后台，失败写进历史 + stderr。要"删得干干净净再回话"就用
 * `deleteServerInstanceAndWait()`（面板删除走的是它）。
 */
export function deleteServerInstance(state: State, id: string): void {
  const name = withState(state, (disk) => deleteInstance(disk, id));
  // 引擎工作副本是 4.5 GB 级的目录：删除**扔到后台**（原生 UI 的渲染循环不能被它挡住），
  // 失败写进历史 + stderr。记录已经删掉了，这时再抛错只会让人以为没删成。
  void removeWorkspace(id).then((failed) => {
    if (failed.length === 0) return;
    const detail = `工作副本没删掉（${failed.join("；")}）—— 人工清理 ${INSTANCES_DIR}/${id}`;
    process.stderr.write(`r5-server: 实例「${name}」的${detail}\n`);
    try {
      const fresh = loadState();
      withState(fresh, (disk) => record(disk, "instance delete", `${name}：${detail}`));
    } catch (err) {
      process.stderr.write(`r5-server: 连状态文件都写不进去：${err instanceof Error ? err.message : String(err)}\n`);
    }
  });
}

function deleteInstance(state: State, id: string): string {
  const index = state.instances.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error(`找不到实例「${id}」`);
  const instance = state.instances[index];
  if (runtimeAlive(instance.runtime)) {
    throw new Error(`实例「${instance.name}」正在运行（pid ${instance.runtime?.pid}）：先在面板里停止它再删。`);
  }
  state.instances.splice(index, 1);
  if (state.selectedInstanceId === id) state.selectedInstanceId = state.instances[0]?.id ?? null;
  record(state, "instance delete", instance.name);
  return instance.name;
}

/** 选中实例：面板的每个动作都作用在它身上。 */
export function selectServerInstance(state: State, id: string): void {
  withState(state, (disk) => {
    const instance = disk.instances.find((entry) => entry.id === id);
    if (instance === undefined) throw new Error(`找不到实例「${id}」`);
    disk.selectedInstanceId = instance.id;
    record(disk, "instance select", instance.name);
  });
}

// ---------------------------------------------------------------- 模式模板

/** 新模板 id（面板新建模板时用；运行时状态一概不落盘）。 */
export function newTemplateId(state: State): string {
  for (;;) {
    const id = `tpl-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    if (!state.templates.some((template) => template.id === id)) return id;
  }
}

/**
 * 存一份模式模板（新建或覆盖）：先 `validateTemplate()`，不通过就整份拒绝 ——
 * 存下来的模板必须能直接下发（键要在玩法声明的清单里，值要归一）。
 */
export function saveModeTemplate(state: State, template: ModeTemplate): void {
  withState(state, (disk) => {
    const problems = validateTemplate(template);
    if (problems.length > 0) throw new Error(problems.join("；"));
    const next: ModeTemplate = { ...template, updatedAt: new Date().toISOString() };
    const index = disk.templates.findIndex((entry) => entry.id === template.id);
    if (index < 0) disk.templates.push(next);
    else disk.templates[index] = next;
    record(disk, "template save", `${next.name} (${next.playlist})`);
  });
}

/** 删模板：**被实例引用时拒绝**（否则那些实例会指向一个不存在的模板）。 */
export function deleteModeTemplate(state: State, id: string): void {
  withState(state, (disk) => {
    const index = disk.templates.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error(`找不到模式模板「${id}」`);
    const used = disk.instances.filter((instance) => instance.templateId === id);
    if (used.length > 0) {
      throw new Error(
        `模板「${disk.templates[index].name}」还被 ${used.length} 个实例引用（${used.map((instance) => instance.name).join("、")}）：先改用别的模板再删。`,
      );
    }
    const [removed] = disk.templates.splice(index, 1);
    record(disk, "template delete", removed.name);
  });
}

/**
 * 这个实例「改了但还没重启」的地方：把进程**实际带着什么起来的**（`runtime.applied`）
 * 与现在记录的值比对。空数组 = 现在记录的就是那个进程在用的。
 *
 * 只比引擎看得见的设置项（`engineName` 有值的那几项）：`logRetention` 这类本机工具设置
 * 改了不需要重启，报出来只会让人白重启一次。
 */
export function instancePendingChanges(state: State, instance: ServerInstance): string[] {
  const runtime = instance.runtime;
  if (runtime === null) return [];
  const applied = runtime.applied;
  if (applied === undefined) {
    return ["这次运行的启动快照没有记录（旧版本启动的）：设置是否生效只能靠重启一次确认。"];
  }
  const changes: string[] = [];
  for (const field of SETTINGS_FIELDS) {
    if (field.engineName === undefined) continue;
    const before = field.display(applied.settings);
    const now = field.display(instance.settings);
    if (before !== now) changes.push(`${field.label}：${before} → ${now}`);
  }
  const template = templateFor(state, instance);
  const appliedTemplateId = applied.templateId;
  const currentTemplateId = template?.id ?? null;
  if (appliedTemplateId !== currentTemplateId) {
    changes.push(
      `模式模板：${appliedTemplateId === null ? "无" : (state.templates.find((t) => t.id === appliedTemplateId)?.name ?? appliedTemplateId)} → ${template?.name ?? "无"}`,
    );
  } else if (template !== null && applied.templateMissing.length > 0) {
    changes.push(
      `这次启动时模板没全部落地（${applied.templateMissing.join("、")} 在玩法 ${applied.playlist} 里没有声明行）：运行期用「template apply」下发，或人工补上该玩法的 vars 行`,
    );
  } else if (template !== null && applied.templateRevision !== template.updatedAt) {
    changes.push(`模式模板「${template.name}」改过了（这次运行用的是更早的一版）`);
  }
  return changes;
}

export type TemplateApplyOutcome = { kind: "success" | "silent" | "error"; message: string };

/**
 * 回读引擎的运行期 playlist 覆盖表（`playlist_override_list`）。
 * 返回 null = 引擎没有任何可用输出（那就**不能**说"已生效"）。
 */
async function readPlaylistOverrides(state: State): Promise<Record<string, string> | null> {
  const receipt = await consoleWithReceipt(state, "playlist_override_list");
  const overrides: Record<string, string> = {};
  let sawHeader = false;
  for (const line of receipt.lines) {
    if (/playlist var override\(s\)/i.test(line)) {
      sawHeader = true;
      continue;
    }
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match !== null) overrides[match[1]] = match[2].trim();
  }
  return sawHeader || Object.keys(overrides).length > 0 ? overrides : null;
}

/** 引擎当前在跑的玩法 / 地图：优先运行期回执，其次启动快照，最后实例设置。 */
function livePlaylist(instance: ServerInstance): string {
  return instance.runtime?.live?.playlist ?? instance.runtime?.applied?.playlist ?? instance.settings.playlist;
}

function liveMap(instance: ServerInstance): string {
  return instance.runtime?.live?.map ?? instance.runtime?.applied?.map ?? instance.settings.map;
}

export type TemplateApplyOptions = {
  /**
   * `true` = **整份应用**（先按模板热切模式 + 地图，再下发参数）。
   * 默认 `false` = 只下发运行参数（下一次重新读取时生效）。
   *
   * 默认不换图：换图会把在线玩家踢下线，那必须是调用方明说的动作（按钮上写清楚
   * "会换图"）。参数模式下如果当前玩法与模板不一致会**直接拒绝** —— 这些参数只对
   * 模板那个玩法的脚本有意义，发到别的玩法上不会生效。
   */
  reload?: boolean;
};

/**
 * 把实例绑定的模板应用到**正在运行的实例**：
 *   1. （reload 时）先按模板热切模式 + 地图 —— 换玩法必须显式做，不能顺手替玩家换图；
 *   2. `playlist_override_clear` 清掉上一版模板留下的运行期覆盖；
 *   3. 逐条下发 `templateCommands()`；
 *   4. `playlist_override_list` 回读确认，**只把回读到的值记进运行记录**。
 *
 * 刻意不做的事：不改启动设置、不写实例的 playlist 文件（那是启动时的事）、
 * 不因为"发出去了"就说"生效了"。回读不到内容就报 `silent`。
 */
export async function applyInstanceTemplate(
  state: State,
  opts: TemplateApplyOptions = {},
): Promise<TemplateApplyOutcome> {
  const reload = opts.reload === true;
  const instance = selectedInstance(state);
  if (instance === null) return { kind: "error", message: "没有选中的实例。" };
  const runtime = instance.runtime;
  if (runtime?.ctlPort === undefined || runtime.ctlToken === undefined) {
    return {
      kind: "error",
      message: "实例没有控制通道（要以托管控制台启动）：先在面板里重启这个实例，再应用模板。",
    };
  }
  const template = templateFor(state, instance);
  if (template === null && instance.templateId !== null) {
    return { kind: "error", message: `找不到实例绑定的模板（${instance.templateId}）：可能已经被删掉了。` };
  }
  const notes: string[] = [];

  if (template === null) {
    // 没有模板：把运行期覆盖清干净（否则上一版模板的参数会一直挂在引擎里）。
    try {
      const receipt = await consoleWithReceipt(state, "playlist_override_clear");
      if (receipt.kind === "unknown") {
        return { kind: "error", message: "引擎不认识 playlist_override_clear：清不掉旧的运行期覆盖，请重启实例。" };
      }
    } catch (err) {
      if (err instanceof NoControlChannelError) return { kind: "error", message: "控制通道不可用：实例可能已经停止。" };
      return { kind: "error", message: `清空覆盖失败：${err instanceof Error ? err.message : String(err)}` };
    }
    if (runtime.overrides !== undefined) {
      withState(state, (disk) => {
        const live = disk.instances.find((entry) => entry.id === instance.id);
        if (live?.runtime !== null && live?.runtime !== undefined) {
          live.runtime = { ...live.runtime, overrides: undefined };
          live.updatedAt = new Date().toISOString();
        }
        record(disk, "template apply", `${instance.name}: 清除运行期覆盖（未绑定模板）`);
      });
    }
    return { kind: "success", message: "已清除运行期 playlist 覆盖（这个实例没有绑定模式模板）。" };
  }

  const problems = validateTemplate(template);
  if (problems.length > 0) return { kind: "error", message: `模板有问题，先修好再应用：${problems.join("；")}` };
  const lines = templateCommands(template);
  const currentPlaylist = livePlaylist(instance);
  const currentMap = liveMap(instance);

  if (reload) {
    if (currentPlaylist !== template.playlist || currentMap !== template.map) {
      const result = await setLiveMode(state, template.playlist, template.map);
      if (result === "no-control") return { kind: "error", message: "控制通道不可用：实例可能已经停止。" };
      if (!result.ok) return { kind: "error", message: `切换到模板的玩法失败：${result.error}` };
      notes.push(`已热切到 ${template.playlist} on ${template.map}（换图会把在线玩家踢下线）`);
    } else {
      notes.push(`引擎回报的玩法与地图已经和模板一致（${template.playlist} on ${template.map}），跳过换图`);
    }
  } else if (currentPlaylist !== template.playlist) {
    return {
      kind: "error",
      message: `现在跑的是 ${currentPlaylist || "(未指定玩法)"}，模板是 ${template.playlist}：这些参数只对该玩法的脚本有意义，切到别的玩法上不会生效。用「立即应用（含换图）」，或先在「运行中」页切到该玩法。`,
    };
  }

  try {
    const cleared = await consoleWithReceipt(state, "playlist_override_clear");
    if (cleared.kind === "unknown") {
      notes.push("引擎不认识 playlist_override_clear：上一版模板留下的运行期覆盖可能还在，必要时重启实例");
    }
    if (lines.length === 0) {
      notes.push(`模板「${template.name}」没有可下发的覆盖项（玩法 ${template.playlist} 没有已证实的可调参数）`);
    }
    for (const line of lines) {
      const receipt = await consoleWithReceipt(state, line);
      if (receipt.kind === "unknown" || receipt.kind === "usage") {
        return { kind: "error", message: `引擎拒绝了「${line}」：${receiptLabel(receipt)}` };
      }
    }
  } catch (err) {
    if (err instanceof NoControlChannelError) return { kind: "error", message: "控制通道不可用：实例可能已经停止。" };
    return { kind: "error", message: `下发失败：${err instanceof Error ? err.message : String(err)}` };
  }

  const wanted = new Map<string, string>();
  for (const line of lines) {
    const match = /^playlist_override_set (\S+) (\S+)$/.exec(line);
    if (match !== null) wanted.set(match[1], match[2]);
  }
  let confirmed: Record<string, string> | null;
  try {
    confirmed = await readPlaylistOverrides(state);
  } catch (err) {
    if (err instanceof NoControlChannelError) return { kind: "error", message: "控制通道不可用：实例可能已经停止。" };
    confirmed = null;
  }
  const at = new Date().toISOString();
  if (confirmed === null) {
    return {
      kind: "silent",
      message: `${notes.join("；")}${notes.length > 0 ? "；" : ""}已下发 ${lines.length} 条 playlist 覆盖，但引擎没有回报覆盖表（playlist_override_list 无输出）→ 无法确认生效。启动值（写进实例 playlist 文件的那份）不受影响。`,
    };
  }
  const appliedEntries = [...wanted].filter(([key]) => confirmed[key] === wanted.get(key));
  const missed = [...wanted.keys()].filter((key) => !appliedEntries.some(([appliedKey]) => appliedKey === key));
  if (instance.runtime !== null) {
    // 运行记录里只留**回读确认过**的那几项：这是证据，不是意图。清空后重下发，所以是替换。
    const confirmedOverrides = appliedEntries.map(([key, value]) => ({ key, value, at }));
    withState(state, (disk) => {
      const live = disk.instances.find((entry) => entry.id === instance.id);
      if (live?.runtime !== null && live?.runtime !== undefined) {
        live.runtime = { ...live.runtime, overrides: confirmedOverrides };
        live.updatedAt = at;
      }
      record(
        disk,
        "template apply",
        `${instance.name}: ${appliedEntries.map(([key, value]) => `${key}=${value}`).join(", ") || "(无覆盖项)"}`,
      );
    });
  }
  if (wanted.size > 0 && appliedEntries.length === 0) {
    return {
      kind: "error",
      message: `${notes.join("；")}${notes.length > 0 ? "；" : ""}引擎回读里没有看到刚下发的值（${[...wanted.keys()].join("、")}）：没有生效。`,
    };
  }
  const effectOf = new Map(templateFields(template.playlist).map((field) => [field.key, field.effect]));
  const late = appliedEntries.filter(([key]) => effectOf.get(key) === "changelevel").map(([key]) => key);
  if (late.length > 0) notes.push(`${late.join("、")} 要等下一次换图才会被脚本重新读取（引擎在关卡初始化时缓存）`);
  if (missed.length > 0) notes.push(`没确认到：${missed.join("、")}`);
  if (appliedEntries.length > 0) {
    notes.push(
      `已确认 ${appliedEntries.length} 项覆盖生效（回读 playlist_override_list）：${appliedEntries.map(([key, value]) => `${key}=${value}`).join(", ")}`,
    );
  } else {
    notes.push("没有需要下发的覆盖项");
  }
  notes.push("运行期覆盖只活在这个进程里，重启后按模板的启动配置重新写入");
  return { kind: missed.length === 0 ? "success" : "silent", message: notes.join("；") };
}

export type InstanceRow = {
  instance: ServerInstance;
  alive: boolean;
  /** 改了但还没重启的地方（空数组 = 记录与进程一致） */
  pending: string[];
};

/** 面板的实例清单（纯取值，不打印）。 */
export function instanceRows(state: State): InstanceRow[] {
  return state.instances.map((instance) => ({
    instance,
    alive: runtimeAlive(instance.runtime),
    pending: instancePendingChanges(state, instance),
  }));
}

export type SetupOptions = {
  ports?: number[];
  dryRun?: boolean;
  noTask?: boolean;
  noFirewall?: boolean;
  noPower?: boolean;
  noDefender?: boolean;
  noPageFile?: boolean;
  taskName?: string;
  pageFileInitMB?: number;
  pageFileMaxMB?: number;
};

function ensureFirewall(port: number, dryRun: boolean): boolean {
  const name = `R5F dedi UDP ${port}`;
  if (win.firewallRuleExists(name)) {
    console.log(dim(`  防火墙规则已存在：${name}`));
    return true;
  }
  if (dryRun) {
    console.log(`  [预演] 将放行 UDP ${port}（规则名 ${name}）`);
    return true;
  }
  const r = win.ps(
    `New-NetFirewallRule -DisplayName ${win.psQuote(name)} -Direction Inbound -Protocol UDP -LocalPort ${port} -Action Allow -Profile Any | Out-Null; 'ok'`,
  );
  const ok = r.out.includes("ok");
  console.log(ok ? green(`  已放行 UDP ${port}`) : red(`  放行失败：${r.err || r.out}`));
  return ok;
}

function configurePageFile(opts: SetupOptions): void {
  if (opts.noPageFile) {
    console.log(dim("  跳过页面文件配置"));
    return;
  }
  const ram = win.physicalRamGB();
  const init = opts.pageFileInitMB ?? (ram > 0 && ram <= 8 ? 8192 : 4096);
  const max = opts.pageFileMaxMB ?? (ram > 0 && ram <= 8 ? 16384 : 8192);
  if (opts.dryRun) {
    console.log(`  [预演] 物理内存 ${ram} GB，将把页面文件设为固定 ${init} MB（上限 ${max} MB）`);
    return;
  }
  const script = [
    "$cs = Get-CimInstance Win32_ComputerSystem",
    "$s = Get-CimInstance Win32_PageFileSetting -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'C:*' } | Select-Object -First 1",
    `if ($s) { Set-CimInstance -InputObject $s -Property @{ InitialSize = ${init}; MaximumSize = ${max} } }`,
    "else {",
    "  Set-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $false }",
    `  New-CimInstance -ClassName Win32_PageFileSetting -Property @{ Name = 'C:\\pagefile.sys'; InitialSize = ${init}; MaximumSize = ${max} } | Out-Null`,
    "}",
    "'ok'",
  ].join("\n");
  const r = win.ps(script);
  console.log(
    r.out.includes("ok")
      ? green(`  页面文件已设为固定 ${init} MB（物理内存 ${ram} GB）`)
      : red(`  页面文件设置失败：${r.err || r.out}`),
  );
  if (ram > 0 && ram <= 8) {
    console.log(
      yellow("  提醒：8 GB 内存跑单实例（私有提交约 6.5 GB）会用到页面文件，换图时可能卡顿；加到 16 GB 更稳。"),
    );
  }
}

function ensureDefenderExclusions(opts: SetupOptions, extraPaths: string[]): void {
  if (opts.noDefender) {
    console.log(dim("  跳过 Defender 排除"));
    return;
  }
  const paths = [ROOT, ...extraPaths];
  if (opts.dryRun) {
    console.log(`  [预演] 将把以下路径加入 Defender 排除：${paths.join(", ")}`);
    return;
  }
  const list = paths.map((p) => win.psQuote(p)).join(",");
  const r = win.ps(
    `try { Add-MpPreference -ExclusionPath @(${list}) -ErrorAction Stop; Add-MpPreference -ExclusionProcess 'r5apex_ds.exe' -ErrorAction SilentlyContinue; 'ok' } catch { 'fail: ' + $_.Exception.Message }`,
  );
  console.log(
    r.out.includes("ok")
      ? green(`  已排除 ${paths.length} 个路径 + r5apex_ds.exe`)
      : red(`  排除失败：${r.out || r.err}`),
  );
}

function ensureScheduledTask(opts: SetupOptions): boolean {
  if (opts.noTask) {
    console.log(dim("  跳过计划任务"));
    return true;
  }
  const taskName = opts.taskName ?? "R5F Dedicated Server";
  const commandLine = taskCommandLine([WORKER_OPS.start]);
  if (opts.dryRun) {
    console.log(`  [预演] 将创建计划任务「${taskName}」：登录时运行 ${commandLine}`);
    return true;
  }
  const r = win.schtasks(["/Create", "/TN", taskName, "/TR", commandLine, "/SC", "ONLOGON", "/RL", "HIGHEST", "/F"]);
  console.log(
    r.code === 0 ? green(`  计划任务已创建：${taskName}（登录时启动）`) : red(`  计划任务创建失败：${r.err || r.out}`),
  );
  return r.code === 0;
}

export async function cmdSetup(state: State, opts: SetupOptions, rawArgs: string[]): Promise<number> {
  const port = portOf(state);
  // 开发模式：把勾选写进模拟主机状态文件（跨进程保留），一行 PowerShell 都不跑。
  if (DEV_MODE) return setupDevHost(opts, port);
  header("Windows 主机配置");
  if (!opts.dryRun && !win.isAdmin()) {
    console.log(yellow("需要管理员权限，正在通过 UAC 提权..."));
    const code = await win.elevateSelf(["setup", ...rawArgs]);
    if (code === null) {
      console.log(red("UAC 被取消，未做任何修改。"));
      return 1223;
    }
    return code;
  }
  // 一个实例占一组 UDP 端口（游戏 / S2S / 客户端），防火墙要整组放行：
  // 只放游戏端口的话，主服的 S2S 探测过不去，服务器上不了架。
  const family = instancePorts(port);
  const ports = (opts.ports && opts.ports.length > 0 ? opts.ports : [family.game, family.s2s, family.client]).filter(
    (p) => Number.isFinite(p) && p > 0 && p <= 65535,
  );
  console.log(dim(`  根目录：${ROOT}`));
  console.log(dim(`  端口：${ports.join(", ")}${opts.dryRun ? "（预演：不会真正修改）" : ""}`));
  if (opts.noFirewall) console.log(dim("  跳过防火墙规则"));
  else ports.forEach((p) => ensureFirewall(p, Boolean(opts.dryRun)));
  configurePageFile(opts);
  const versionPaths = discoverVersions(ROOT, { withSizes: false }).map((v) => v.path);
  ensureDefenderExclusions(opts, versionPaths);
  const taskConfigured = ensureScheduledTask(opts);
  if (opts.noPower) {
    console.log(dim("  跳过电源计划"));
  } else if (opts.dryRun) {
    console.log(`  [预演] 将把电源计划设为高性能`);
  } else {
    const r = win.ps("powercfg.exe /setactive SCHEME_MIN; 'ok'");
    console.log(r.out.includes("ok") ? green("  电源计划：高性能") : red(`  电源计划设置失败：${r.err || r.out}`));
  }
  console.log("");
  console.log(dim("  云侧还要做一步：腾讯云轻量控制台 → 防火墙 → 放行同样的 UDP 端口。"));
  console.log(dim("  云防火墙与 Windows 防火墙是两道独立门，必须都开。"));
  withState(state, (disk) => record(disk, "setup", `ports=${ports.join(",")} dryRun=${Boolean(opts.dryRun)}`));
  return taskConfigured ? 0 : 1;
}

export type SettingChange = { id: FieldId; raw: string };

/**
 * Persist validated changes. Every surface (settings page, worker op) funnels
 * through the field table, so a value accepted in one place is accepted in all.
 */
export type SettingsOutcome = { applied: string[]; failed: string[] };

/**
 * 应用一批设置改动到**选中实例**（面板唯一入口）。返回逐条结果，不打印。
 * 设置是实例自己的：改哪个实例就写哪个实例的记录，别的实例一个字都不动。
 */
export function saveSettings(state: State, changes: SettingChange[]): SettingsOutcome {
  return withState(state, (disk) => {
    const instance = selectedInstance(disk);
    if (instance === null) return { applied: [], failed: ["没有选中的实例（先在「服务器实例」页选一个）"] };
    const applied: string[] = [];
    const failed: string[] = [];
    for (const change of changes) {
      const field = fieldById(change.id);
      const parsed = applyFieldValue(instance.settings, change.id, change.raw);
      if (!parsed.ok) {
        failed.push(`${field.label}：${parsed.error}`);
        continue;
      }
      applied.push(`${field.label} = ${field.display(instance.settings)}`);
    }
    if (applied.length > 0) {
      instance.updatedAt = new Date().toISOString();
      record(disk, "settings", `${instance.name}: ${applied.join("; ")}`);
    }
    return { applied, failed };
  });
}

export type AutostartAction = "enable" | "disable" | "status" | "run";

export type AutostartOptions = {
  action: AutostartAction;
  taskName?: string;
  trigger?: "logon" | "startup";
  extraArgs?: string;
  dryRun?: boolean;
};

const DEFAULT_TASK = "R5F Dedicated Server";

/**
 * 计划任务要执行的那条命令行：重新进入内部 worker 的完整 argv，按 Windows 的
 * 参数规则逐段加引号（`schtasks /TR` 收的就是一整条命令行）。
 * 计划任务在登录/开机时由系统拉起，所以前缀仍然由宿主给（打包 = exe + `--worker`）。
 */
function taskCommandLine(extraArgs: string[]): string {
  return workerCommand(extraArgs).map(windowsArg).join(" ");
}

export async function cmdAutostart(state: State, opts: AutostartOptions, rawArgs: string[]): Promise<number> {
  const instance = selectedOrComplain(state);
  if (instance === null) return 1;
  // 开发模式：计划任务只存在于模拟主机状态文件里（`run` 明确不支持：没有真任务可触发）。
  if (DEV_MODE) return autostartDevHost(opts, portOf(state));
  const taskName = opts.taskName ?? DEFAULT_TASK;
  header(`开机自启：${opts.action} · ${instance.name}`);
  if (opts.dryRun) {
    const trigger = opts.trigger === "startup" ? "ONSTART" : "ONLOGON";
    console.log(dim("  [预演] 不会修改系统"));
    kv("任务名", taskName);
    kv("触发", trigger === "ONLOGON" ? "用户登录时" : "开机时");
    kv(
      "命令",
      taskCommandLine([
        WORKER_OPS.start,
        "--instance",
        instance.id,
        ...(opts.extraArgs ? opts.extraArgs.split(/\s+/).filter(Boolean) : []),
      ]),
    );
    kv("权限", "/RL HIGHEST（最高权限）");
    return 0;
  }
  // `status` only reads, so it must not trigger a UAC prompt.
  if (opts.action !== "status" && !win.isAdmin()) {
    console.log(yellow("需要管理员权限，正在通过 UAC 提权..."));
    const code = await win.elevateSelf(["autostart", ...rawArgs]);
    if (code === null) {
      console.log(red("UAC 被取消。"));
      return 1223;
    }
    return code;
  }
  if (opts.action === "status") {
    const r = win.ps(
      `$t = Get-ScheduledTask -TaskName ${win.psQuote(taskName)} -ErrorAction SilentlyContinue; ` +
        `if ($t) { "$($t.State)|$($t.Actions[0].Execute) $($t.Actions[0].Arguments)" } else { 'MISSING' }`,
    );
    if (r.out.startsWith("MISSING") || r.out.length === 0) {
      console.log(yellow(`  计划任务「${taskName}」不存在。`));
      console.log(dim("  开启：在「主机环境」页点「应用主机配置」（会默认建登录时启动的任务）"));
      return 1;
    }
    const [stateText, ...rest] = r.out.split("|");
    kv("任务名", taskName);
    kv(
      "状态",
      stateText === "Ready" ? green("已就绪（等待触发）") : stateText === "Running" ? green("正在运行") : stateText,
    );
    kv("命令", rest.join("|"));
    console.log("");
    console.log(dim("  提醒：计划任务在「用户登录时」触发，服务器需要有自动登录或一次 RDP 登录。"));
    console.log(dim("  触发后由计划任务按上面的命令行拉起服务端；想立刻看到结果：重启后在面板里手动启动一次。"));
    return 0;
  }
  if (opts.action === "disable") {
    const r = win.schtasks(["/Delete", "/TN", taskName, "/F"]);
    if (r.code !== 0) {
      console.log(red(`  删除失败：${r.err || r.out}`));
      return 1;
    }
    console.log(green(`  已删除计划任务「${taskName}」`));
    withState(state, (disk) => record(disk, "autostart", `disable ${taskName}`));
    return 0;
  }
  if (opts.action === "run") {
    const r = win.schtasks(["/Run", "/TN", taskName]);
    console.log(r.code === 0 ? green(`  已触发「${taskName}」`) : red(`  触发失败：${r.err || r.out}`));
    return r.code === 0 ? 0 : 1;
  }
  // enable：任务里钉死 `--instance <id>`，否则"现在选中了谁"一变，自启起来的就是别的实例。
  const commandLine = taskCommandLine([
    WORKER_OPS.start,
    "--instance",
    instance.id,
    ...(opts.extraArgs ? opts.extraArgs.split(/\s+/).filter(Boolean) : []),
  ]);
  const trigger = opts.trigger === "startup" ? "ONSTART" : "ONLOGON";
  const r = win.schtasks(["/Create", "/TN", taskName, "/TR", commandLine, "/SC", trigger, "/RL", "HIGHEST", "/F"]);
  if (r.code !== 0) {
    console.log(red(`  创建失败：${r.err || r.out}`));
    return 1;
  }
  console.log(green(`  已创建计划任务「${taskName}」（${trigger === "ONLOGON" ? "登录时" : "开机时"}启动）`));
  console.log(dim(`  命令：${commandLine}`));
  if (trigger === "ONSTART") {
    console.log(yellow("  开机触发会在会话 0 中运行，服务端的控制台窗口不可见；如需可见请用登录触发 + 自动登录。"));
  } else {
    console.log(dim("  需要自动登录（netplwiz）或重启后手动登录一次，任务才会触发。"));
  }
  withState(state, (disk) => record(disk, "autostart", `enable ${taskName} trigger=${trigger}`));
  return 0;
}

// ------------------------------------------------------------ server console

/**
 * Console channel into the running instance.
 *
 * The hosted console's input pipe (`R5F_CONSOLE_IN`) has console authority:
 * writing a line runs it on the server console. The detached log daemon holds
 * that pipe, so commands travel over its loopback control port instead — no
 * extra public port, no RCON password, no custom protocol.
 */
export type ConsoleReply = { ok: boolean; reason?: string };

function controlSend(port: number, token: string, lines: string[], timeoutMs = 4000): Promise<ConsoleReply> {
  const outcome = Promise.withResolvers<ConsoleReply>();
  const socket = netConnect({ host: "127.0.0.1", port });
  let buffer = "";
  let authed = false;
  let replied = 0;
  const expected = lines.length + 1;
  const finish = (reply: ConsoleReply): void => {
    socket.destroy();
    outcome.resolve(reply);
  };
  const timer = setTimeout(() => finish({ ok: false, reason: "控制通道超时（日志守护是否还在？）" }), timeoutMs);
  socket.on("error", (err: Error) => {
    clearTimeout(timer);
    finish({ ok: false, reason: `控制通道连接失败：${err.message}` });
  });
  socket.on("connect", () => {
    socket.write(`AUTH ${token}\n`);
  });
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!authed) {
        if (line !== "OK auth") {
          clearTimeout(timer);
          finish({ ok: false, reason: "控制通道鉴权失败" });
          return;
        }
        authed = true;
        socket.write(`${lines[0]}\n`);
        replied = 1;
        continue;
      }
      if (line === "ERR no-engine") {
        clearTimeout(timer);
        finish({ ok: false, reason: "引擎未连接控制台管道（不是托管控制台启动？）" });
        return;
      }
      if (line.startsWith("ERR")) {
        clearTimeout(timer);
        finish({ ok: false, reason: line });
        return;
      }
      replied += 1;
      if (replied >= expected) {
        clearTimeout(timer);
        finish({ ok: true });
        return;
      }
      socket.write(`${lines[replied - 1]}\n`);
    }
  });
  return outcome.promise;
}

/** 实例不是用托管控制台启动的：没有 `ctlPort`/令牌（worker 映射到退出码 2）。 */
export class NoControlChannelError extends Error {
  constructor(message = NO_CONTROL_MESSAGE) {
    super(message);
    this.name = "NoControlChannelError";
  }
}

/** 没有托管控制台时的统一文案（worker、面板共用）。 */
export const NO_CONTROL_MESSAGE = "这台服务器没有控制通道（上次启动时没开），重启服务器后就能用。";

/** 发送前的水位线：文件不存在返回 0。 */
export async function logWatermark(path: string): Promise<number> {
  if (path.length === 0) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** 只读 offset 之后的新增行；文件被截断（size < offset）则从头读。 */
export async function readAfter(path: string, offset: number): Promise<string[]> {
  if (path.length === 0) return [];
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  const from = size < offset ? 0 : offset;
  if (size === from) return [];
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    return buffer
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => stripAnsi(line))
      .filter((line) => line.trim().length > 0);
  } finally {
    closeSync(fd);
  }
}

/**
 * 发送一条控制台命令并分类引擎的回答。
 *
 * 只认本次发送产生的新行：发送前记水位线，发送后只读它之后的内容 —— 否则会匹配到
 * 上一条命令、甚至上一次运行的输出（实测同一个日志分片里躺着 8 次启动横幅）。
 */
export async function consoleWithReceipt(state: State, line: string, waitMs = 1200): Promise<Receipt> {
  const runtime = runtimeOf(state);
  if (!runtime?.pid) throw new NoControlChannelError("没有正在运行的实例。");
  if (!runtime.ctlPort || !runtime.ctlToken) throw new NoControlChannelError();
  const logFile = runtime.logFile ?? "";
  const from = await logWatermark(logFile);
  const reply = await controlSend(runtime.ctlPort, runtime.ctlToken, [line]);
  if (!reply.ok) throw new Error(`发送失败：${reply.reason ?? "未知原因"}`);
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const lines = await readAfter(logFile, from);
    const receipt = classifyReceipt(lines);
    // 有新增行就说明引擎已经回话（哪怕是我们认不出的内容）；一行都没有就等满窗口。
    if (lines.length > 0 || Date.now() >= deadline) return receipt;
    await Bun.sleep(120);
  }
}

/** 一个 kind 一条文案；silent 的文案取决于引擎到底有没有输出行。 */
const RECEIPT_LABELS: Record<ReceiptKind, (receipt: Receipt) => string> = {
  success: (receipt) => `执行结果：成功（${receipt.detail}）`,
  unknown: (receipt) => `执行结果：命令不存在（${receipt.detail}）`,
  usage: (receipt) => `执行结果：用法错误或被拒（${receipt.detail}）`,
  silent: (receipt) =>
    receipt.lines.length === 0
      ? "执行结果：已发送（引擎无回执）—— 命令存在（未知命令引擎必定报错），但引擎没有任何输出，无法确认执行成功"
      : `执行结果：已发送（引擎无确认回执）—— 引擎有 ${receipt.lines.length} 行输出（见下），其中没有成功/失败确认行`,
};

/** 回执的中文结论（worker 与面板共用同一套文案）。 */
export function receiptLabel(receipt: Receipt): string {
  return RECEIPT_LABELS[receipt.kind](receipt);
}

export type PlayerRow = {
  userid: string;
  name: string;
  uniqueid: string;
  connected: string;
  ping: string;
  loss: string;
  state: string;
  rate: string;
};

/**
 * The tail holds every `status` block we ever ran; only the last one is current.
 * A block starts at the `hostname:` line and ends at `#end`.
 */
export function lastStatusBlock(lines: string[]): string[] {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/hostname\s*:/i.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return lines;
  const end = lines.findIndex((line, index) => index > start && /#end\s*$/.test(line));
  return end > start ? lines.slice(start, end + 1) : lines.slice(start);
}

/** Parse the engine's `status` block (Source layout, S21 dedi wording). */
export function parseStatusBlock(source: string[]): { header: string[]; players: PlayerRow[] } {
  const lines = lastStatusBlock(source);
  const headerLines: string[] = [];
  const players: PlayerRow[] = [];
  for (const raw of lines) {
    const line = raw
      .replace(/^\[[\d.]+\]\s*/, "")
      .replace(/^Native\([A-Z]\):/, "")
      .trim();
    if (line.length === 0) continue;
    if (/^#\s*userid\s+name/i.test(line)) continue;
    if (/^#end$/.test(line)) continue;
    if (/^(hostname|version|udp\/ip|os\/type|players|map\s*:|game\s*:)/i.test(line) || /^\d+ humans/.test(line)) {
      headerLines.push(line);
      continue;
    }
    // id64 是 17 位，但机器人（实测 `# 1 "bot0" 0 00:01 0 0 active 256000`）的
    // uniqueid 就是 `0` —— 只要求是数字，否则机器人行整行被丢掉。
    const cells = line.match(/^#?\s*(\d+)\s+(.*?)\s+(\d+)\s+([\d:]+)\s+(\d+)\s+(\d+)\s+(\w+)\s+(\d+)\s*$/);
    if (cells) {
      players.push({
        userid: cells[1],
        name: cells[2],
        uniqueid: cells[3],
        connected: cells[4],
        ping: cells[5],
        loss: cells[6],
        state: cells[7],
        rate: cells[8],
      });
    }
  }
  return { header: headerLines, players };
}

/** `status` over the console channel, parsed. */
export async function fetchPlayers(state: State): Promise<{ header: string[]; players: PlayerRow[]; error?: string }> {
  const runtime = runtimeOf(state);
  if (!runtime?.ctlPort || !runtime.ctlToken)
    return { header: [], players: [], error: "没有控制通道（需托管控制台启动）" };
  const reply = await controlSend(runtime.ctlPort, runtime.ctlToken, ["status"]);
  if (!reply.ok) return { header: [], players: [], error: reply.reason ?? "发送失败" };
  await Bun.sleep(900);
  if (!runtime.logFile || !existsSync(runtime.logFile)) return { header: [], players: [] };
  return parseStatusBlock(readTail(runtime.logFile, 200));
}

export type ModerateOptions = { json?: boolean; minutes?: number; reason?: string };

/** 临时封禁上限：7 天。再长就不是"临时处置"了，直接用永久封禁。 */
const MAX_TEMP_BAN_MINUTES = 7 * 24 * 60;

type Resolved = { id64: string; name: string; userid: string };

/**
 * 封禁记录要能自动解封，就必须拿到 id64 —— 引擎的解封形式是 `unban "<userId>"/"<ipAddress>"`
 * （实测 `help unban`），userid 是会话内的槽位号，重启后没意义。
 */
async function resolveTarget(
  state: State,
  target: string,
): Promise<{ ok: true; player: Resolved } | { ok: false; error: string }> {
  const wanted = target.trim();
  if (/^\d{15,20}$/.test(wanted)) return { ok: true, player: { id64: wanted, name: "", userid: wanted } };
  const result = await fetchPlayers(state);
  if (result.error) return { ok: false, error: result.error };
  const player = result.players.find((row) => row.userid === wanted || row.uniqueid === wanted);
  if (!player) return { ok: false, error: `在线列表里没有 userid/id64 = ${wanted} 的玩家。` };
  if (player.uniqueid === "0")
    return { ok: false, error: `「${stripName(player.name)}」是机器人（没有 id64），机器人封不了 —— 只能踢。` };
  return { ok: true, player: { id64: player.uniqueid, name: stripName(player.name), userid: player.userid } };
}

/** `status` 行的名字带引号（实测 `"bot0"`）—— 显示与按名字重试都要去掉。 */
function stripName(name: string): string {
  return name.replace(/^"+|"+$/g, "");
}

export type ModerateOutcome =
  | { ok: false; error: string; hint?: string; exitCode: number }
  | {
      ok: true;
      action: "kick" | "ban" | "unban";
      receipt: Receipt;
      label: string;
      /** 写进本机台账的封禁记录（只有 ban 有） */
      entry?: ModerationEntry;
      /** 解封时被标为「已解除」的台账条数 */
      released?: number;
    };

/** 带记录的封禁：先发引擎命令，再记本地台账（见 `moderation.ts` 的说明）。 */
async function banWithRecord(
  state: State,
  target: string,
  opts: ModerateOptions,
): Promise<ModerateOutcome | "no-control"> {
  const minutes = opts.minutes ?? 0;
  const reason = (opts.reason ?? "").trim();
  if (!Number.isInteger(minutes) || minutes < 0) {
    return { ok: false, error: "--minutes 需要 ≥ 0 的整数（0 或不写 = 永久）。", exitCode: 1 };
  }
  if (minutes > MAX_TEMP_BAN_MINUTES) {
    return {
      ok: false,
      error: `--minutes 最大 ${MAX_TEMP_BAN_MINUTES}（7 天）。更久请用不带 --minutes 的永久封禁。`,
      exitCode: 1,
    };
  }
  const resolved = await resolveTarget(state, target);
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error,
      hint: "没有向引擎发送任何封禁指令（只读查了在线名单）。名单在「运行中」页的玩家列表里。",
      exitCode: resolved.error.includes("控制通道") || resolved.error.includes("没有正在运行") ? 2 : 1,
    };
  }
  let receipt: Receipt;
  try {
    receipt = await consoleWithReceipt(state, `ban "${target.trim()}"`);
  } catch (err) {
    if (err instanceof NoControlChannelError) return "no-control";
    return { ok: false, error: err instanceof Error ? err.message : String(err), exitCode: 1 };
  }
  if (receipt.kind === "unknown" || receipt.kind === "usage") {
    return {
      ok: false,
      error: `${receiptLabel(receipt)} —— 引擎拒绝/不认这条命令，没有写本地记录。`,
      exitCode: 1,
    };
  }
  const now = Date.now();
  const entry: ModerationEntry = {
    id: randomUUID(),
    target: target.trim(),
    id64: resolved.player.id64,
    name: resolved.player.name,
    reason,
    minutes,
    issuedAt: now,
    expiresAt: minutes > 0 ? now + minutes * 60_000 : 0,
    state: "pending",
  };
  addRecord(ROOT, entry);
  return { ok: true, action: "ban", receipt, label: receiptLabel(receipt), entry };
}

/**
 * 踢 / 封 / 解封的结构化版本：拿回执与台账结果，不打印。
 *
 * 实测（本机 r5f-dedi 1.0.13 托管实例）：`kick "<userid>"` 对机器人静默且不生效，
 * 而 `kick "<玩家名>"` 回 `Kicked '…' from server` —— "静默"就如实说静默；
 * `botsClear` 里补了按名字重试的回退。
 */
export async function moderate(
  state: State,
  action: "kick" | "ban" | "unban",
  target: string,
  opts: ModerateOptions = {},
): Promise<ModerateOutcome | "no-control"> {
  const trimmed = target.trim();
  if (trimmed.length === 0) {
    const verb = action === "unban" ? "解封" : action === "ban" ? "封禁" : "踢出";
    return { ok: false, error: `没有给出要${verb}的目标（userid 或 id64）`, exitCode: 1 };
  }
  if (action === "ban" && (opts.minutes !== undefined || opts.reason !== undefined)) {
    return banWithRecord(state, trimmed, opts);
  }
  const line = action === "unban" ? `unban "${trimmed}"` : `${action} "${trimmed}"`;
  let receipt: Receipt;
  try {
    receipt = await consoleWithReceipt(state, line);
  } catch (err) {
    if (err instanceof NoControlChannelError) return "no-control";
    return { ok: false, error: err instanceof Error ? err.message : String(err), exitCode: 1 };
  }
  const released = action === "unban" ? markUnbannedByTarget(ROOT, trimmed, Date.now()) : 0;
  return { ok: true, action, receipt, label: receiptLabel(receipt), released };
}

// -------------------------------------------------------------------- bots

/** 机器人判据：`status` 行里 `uniqueid === "0"`（实测机器人没有 id64）。 */
export async function fetchBots(state: State): Promise<{ bots: PlayerRow[]; error?: string }> {
  const result = await fetchPlayers(state);
  if (result.error) return { bots: [], error: result.error };
  return { bots: result.players.filter((player) => player.uniqueid === "0") };
}

export type BotAddOptions = { count?: number; name?: string; team?: 0 | 1 | 2 };

export type BotsAddOutcome =
  | { ok: false; error: string; hint?: string; exitCode: number }
  | { ok: true; line: string; receipt: Receipt; label: string };

/** 造机器人：有 `name` 走 `sv_addbot <name> <team>`，否则 `spawnbots <count>`。 */
export async function botsAdd(state: State, opts: BotAddOptions = {}): Promise<BotsAddOutcome | "no-control"> {
  const name = (opts.name ?? "").trim();
  const count = opts.count ?? 1;
  const team = opts.team ?? 0;
  let line: string;
  if (name.length > 0) {
    if (count !== 1) {
      return {
        ok: false,
        error: "--name 与 --count 不能一起用：sv_addbot 一次只加一个具名机器人。",
        hint: "要一批同款机器人就不要填名字，直接给数量（走 spawnbots）",
        exitCode: 1,
      };
    }
    if (/\s/.test(name)) {
      return {
        ok: false,
        error: "名字不能包含空格（引擎用法字符串：name(string) teamid(int)，按空格分词）。",
        exitCode: 1,
      };
    }
    line = `sv_addbot ${name} ${team}`;
  } else {
    // 实测 `spawnbots 0` 生成了 1 个机器人 → 0 的语义不明确，拒绝而不是猜。
    if (!Number.isInteger(count) || count < 1) {
      return {
        ok: false,
        error: "--count 需要 ≥ 1 的整数（实测 spawnbots 0 会生成 1 个机器人，语义未证实）。",
        exitCode: 1,
      };
    }
    line = `spawnbots ${count}`;
  }
  try {
    const receipt = await consoleWithReceipt(state, line);
    return { ok: true, line, receipt, label: receiptLabel(receipt) };
  } catch (err) {
    if (err instanceof NoControlChannelError) return "no-control";
    return { ok: false, error: err instanceof Error ? err.message : String(err), exitCode: 1 };
  }
}

export type BotsClearOutcome =
  | { ok: false; error: string; exitCode: number }
  | {
      ok: true;
      /** 开始时看到的机器人数 */
      before: number;
      /** 清理后仍在的数量 */
      remaining: number;
      /** 引擎明确回 success 的次数 */
      confirmed: number;
      /** 被引擎拒绝的次数 */
      refused: number;
    };

/** 清空机器人：`kick` 逐个来（先 userid 形式，静默则按名字重试），最多 2 轮 × 32 个。 */
export async function botsClear(state: State): Promise<BotsClearOutcome | "no-control"> {
  const first = await fetchBots(state);
  if (first.error) return { ok: false, error: first.error, exitCode: 1 };
  if (first.bots.length === 0) {
    return { ok: true, before: 0, remaining: 0, confirmed: 0, refused: 0 };
  }
  let confirmed = 0;
  let refused = 0;
  for (let round = 0; round < 2; round += 1) {
    const { bots, error } = await fetchBots(state);
    if (error) return { ok: false, error, exitCode: 1 };
    if (bots.length === 0) break;
    for (const bot of bots.slice(0, 32)) {
      // 实测（本机 r5f-dedi 1.0.13 托管实例，2026-09-14）：`kick "<userid>"` 对机器人
      // 静默且不生效（机器人仍在列表里），`kick "<name>"` 才回 `Kicked '…' from server`。
      // ticket 01 的实测结论相反 —— 所以两种形式都发：先 ticket 的 userid 形式，
      // 没有成功回执再用名字；只有拿到 success 才算踢掉，静默永远不当成功。
      const botName = stripName(bot.name);
      const tries = [`kick "${bot.userid}"`];
      if (botName.length > 0) tries.push(`kick "${botName}"`);
      let receipt: Receipt | null = null;
      for (const line of tries) {
        try {
          receipt = await consoleWithReceipt(state, line);
        } catch (err) {
          if (err instanceof NoControlChannelError) return "no-control";
          return { ok: false, error: err instanceof Error ? err.message : String(err), exitCode: 1 };
        }
        if (receipt.kind === "success") break;
      }
      if (receipt === null) continue;
      if (receipt.kind === "success") confirmed += 1;
      else if (receipt.kind !== "silent") refused += 1;
    }
  }
  const after = await fetchBots(state);
  if (after.error) return { ok: false, error: after.error, exitCode: 1 };
  return { ok: true, before: first.bots.length, remaining: after.bots.length, confirmed, refused };
}

export type BanlistView = {
  /** 找到的 banlist.json 路径（引擎首次真正封禁后才生成） */
  file: string | null;
  /** 原样解析出的 JSON；结构由引擎/Spire 侧决定 */
  data: unknown;
  /** 本机台账里的临时封禁记录 */
  ledger: ModerationEntry[];
  reload: Receipt | null;
};

export type BanlistOutcome = { ok: false; error: string; exitCode: number } | { ok: true; view: BanlistView };

/** 引擎可能放 `banlist.json` 的几个位置（版本目录只读，这里只做存在性检查）。 */
export function banlistCandidates(state: State): string[] {
  const version = currentVersion(state);
  if (!version) return [];
  return [
    join(version.path, "banlist.json"),
    join(version.path, "platform", "banlist.json"),
    join(version.path, "platform", "cfg", "banlist.json"),
  ];
}

/**
 * 读封禁名单：引擎的 `banlist.json`（原样 JSON）+ 本机台账 + 可选的 `banlist_reload`。
 *
 * `banlist_reload` 实测静默（命令存在、无输出）→ 静默不等于成功，回执原样带出。
 */
export async function readBanlist(
  state: State,
  opts: { reload?: boolean } = {},
): Promise<BanlistOutcome | "no-control"> {
  const candidates = banlistCandidates(state);
  const file = candidates.find((path) => existsSync(path)) ?? null;

  let reload: Receipt | null = null;
  if (opts.reload) {
    try {
      reload = await consoleWithReceipt(state, "banlist_reload");
    } catch (err) {
      if (err instanceof NoControlChannelError) return "no-control";
      return { ok: false, error: err instanceof Error ? err.message : String(err), exitCode: 1 };
    }
  }

  let data: unknown = null;
  if (file) {
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      return {
        ok: false,
        error: `${file} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
        exitCode: 1,
      };
    }
  }
  return { ok: true, view: { file, data, ledger: loadModeration(ROOT).entries, reload } };
}

export type ModeSetOutcome =
  | { ok: false; error: string; exitCode: number }
  | { ok: true; playlist: string; map: string; mode: ModeEntry | null; receipt: Receipt };

/** 运行期一步热切模式+地图；省略 map 时用模式默认地图。 */
export async function setLiveMode(
  state: State,
  playlist: string,
  map?: string,
): Promise<ModeSetOutcome | "no-control"> {
  const id = playlist.trim();
  if (id.length === 0) return { ok: false, error: "没有指定要切到的玩法（playlist）", exitCode: 1 };
  const instance = selectedInstance(state);
  const runtime = instance?.runtime ?? null;
  if (!runtime?.ctlPort || !runtime.ctlToken) return "no-control";
  const version = currentVersion(state);
  const families: ModeFamily[] = version ? await collectModes(version.path) : [];
  const modes = families.flatMap((family) => family.modes);
  const mode = modes.find((entry) => entry.id === id) ?? null;
  const chosenMap = (map ?? "").trim() || mode?.map || mapsForPlaylist(modes, id)[0] || "";
  if (chosenMap.length === 0) {
    return {
      ok: false,
      error: `无法确定「${id}」的地图：引擎用法是 bridge_setmode <playlist> <map>，两个参数都不能省。`,
      exitCode: 1,
    };
  }
  let receipt: Receipt;
  try {
    receipt = await consoleWithReceipt(state, `bridge_setmode ${id} ${chosenMap}`);
  } catch (err) {
    if (err instanceof NoControlChannelError) return "no-control";
    return { ok: false, error: err instanceof Error ? err.message : String(err), exitCode: 1 };
  }
  // 运行期数据记在**实例自己的**运行记录上：别的实例的 live 不受影响。
  const live = parseLiveLevel(receipt.lines);
  if (live && instance !== null && instance.runtime !== null) {
    const at = new Date().toISOString();
    withState(state, (disk) => {
      const target = disk.instances.find((entry) => entry.id === instance.id);
      if (target?.runtime !== null && target?.runtime !== undefined) {
        // 回执里带着引擎真正的切换结果 —— 存起来，`status` 就不用拿启动设置冒充"当前"了。
        target.runtime = { ...target.runtime, live: { ...live, at } };
      }
      record(disk, "mode set", `${instance.name}: ${live.playlist} ${live.map}`);
    });
  }
  return { ok: true, playlist: id, map: chosenMap, mode, receipt };
}

/**
 * `bridge_setmode` 成功时引擎会回 `Starting server with name: "x" map: "y" mode: "z"`
 * （实测 1.0.13：`mode set fs_1v1 mp_rr_aqueduct` → 该行 + `CHostState::State_ChangeLevelMP`）。
 */
export function parseLiveLevel(lines: string[]): { playlist: string; map: string } | null {
  for (const raw of lines) {
    const line = normaliseLogLine(raw);
    const match = /^Starting server with name: ".+" map: "(.+)" mode: "(.+)"/.exec(line);
    if (match) return { map: match[1], playlist: match[2] };
  }
  return null;
}
