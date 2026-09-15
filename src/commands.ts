import { randomUUID } from "node:crypto";
/**
 * Command implementations: list / use / start / stop / status / upgrade /
 * setup / settings / doctor / logs / console / players / bots / moderation /
 * banlist / announcements / mode / health.
 */
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import stringWidth from "string-width";
import { type Announcement, collectAnnouncements, renderAnnouncements, validateAnnouncement } from "./announcements";
import { type ModeEntry, type ModeFamily, collectModes, mapsForPlaylist } from "./catalog";
import { type CfgSync, syncLaunchSettings } from "./cfg";
import { type Section, type Tone, collectDetail, collectDoctor, collectHealth } from "./inspect";
import {
  type ModerationEntry,
  addRecord,
  describeExpiry,
  loadModeration,
  markUnbannedByTarget,
  moderationPath,
} from "./moderation";
import { type Receipt, type ReceiptKind, classifyReceipt, normaliseLogLine } from "./receipt";
import { currentVersion, describe } from "./serverinfo";
import { SETTINGS_FIELDS, type FieldId, applyFieldValue, fieldById } from "./settings-fields";
import {
  BACKUP_DIR,
  ROOT,
  loadState,
  record,
  saveState,
  syncActiveProfile,
  type AuthMode,
  type Settings,
  type State,
  type Visibility,
} from "./state";
import { hostedEnv, isPidAlive, logDir, makeTapNames, readTail, selfCommand, stripAnsi } from "./tap";
import { bold, choose, confirm, dim, green, header, kv, padEndWidth, red, yellow } from "./ui";
import { asRecord } from "./util";
import { OPERATOR_FILES, type VersionInfo, discoverVersions, formatSize, isNewer } from "./versions";
import * as win from "./win";

const EXE = "r5apex_ds.exe";

function findByNameOrVersion(name: string): VersionInfo | null {
  const versions = discoverVersions(ROOT);
  const exact = versions.find((v) => v.name === name);
  if (exact) return exact;
  const byVersion = versions.find((v) => v.version && v.version.join(".") === name.replace(/^v/, ""));
  return byVersion ?? null;
}

/** Map a collector tone onto the pty-safe CLI palette. */
function toneText(text: string, tone?: Tone): string {
  if (tone === "green") return green(text);
  if (tone === "yellow") return yellow(text);
  if (tone === "red") return red(text);
  if (tone === "dim") return dim(text);
  return text;
}

/** Print collected sections the way `status`/`doctor` always looked. */
function printSections(sections: Section[]): void {
  for (const section of sections) {
    console.log("");
    console.log(bold(section.title));
    for (const row of section.rows) kv(row.label, toneText(row.value, row.tone));
  }
}

export function cmdList(state: State, opts: { withSizes?: boolean } = {}): void {
  const versions = discoverVersions(ROOT, { withSizes: opts.withSizes !== false });
  header("可用服务器版本");
  if (versions.length === 0) {
    console.log(red(`  ${ROOT} 下没有含 r5apex_ds.exe + server.dll + loader.dll 的版本目录。`));
    console.log(dim("  把解压后的 r5f-dedi-x.y.z 目录放进这里即可被识别。"));
    return;
  }
  versions.forEach((v, i) => {
    const mark = v.name === state.current ? green(" ← 当前使用") : "";
    console.log(`  ${bold(String(i + 1).padStart(2))}) ${bold(v.name)}${mark}`);
    console.log(`      ${dim(describe(v))}`);
  });
  console.log("");
  kv("根目录", ROOT);
  kv("状态文件", join(ROOT, "r5-server.json"));
}

async function pickVersion(state: State, question = "选择要使用的服务器版本"): Promise<VersionInfo | null> {
  const versions = discoverVersions(ROOT, { withSizes: false });
  if (versions.length === 0) {
    console.log(red("没有可用版本目录，先把服务器目录放到 " + ROOT + " 下。"));
    return null;
  }
  const chosen = await choose(
    question,
    versions.map((v) => ({ label: v.name, note: v.gameVersion || undefined, value: v })),
  );
  return chosen;
}

/** Resolve the version to operate on, prompting (and persisting) when needed. */
async function ensureVersion(state: State, interactive: boolean): Promise<VersionInfo | null> {
  const existing = currentVersion(state);
  if (existing) return existing;
  console.log(yellow("尚未选择服务器版本，先选一个："));
  if (!interactive) {
    cmdList(state, { withSizes: false });
    console.log(yellow("非交互模式下请先执行：r5-server use <目录名>"));
    return null;
  }
  const picked = await pickVersion(state);
  if (!picked) return null;
  state.current = picked.name;
  record(state, "use", picked.name);
  saveState(state);
  console.log(green(`已记录：${picked.name}（后续 start/upgrade 都基于它）`));
  return picked;
}

export async function cmdUse(state: State, name?: string): Promise<number> {
  let target: VersionInfo | null = null;
  if (name) {
    target = findByNameOrVersion(name);
    if (!target) {
      console.log(red(`找不到版本「${name}」。`));
      cmdList(state, { withSizes: false });
      return 1;
    }
  } else {
    const versions = discoverVersions(ROOT, { withSizes: false });
    if (versions.length === 0) {
      console.log(red("没有可用版本目录。"));
      return 1;
    }
    target = await pickVersion(state, "切换到哪个版本");
  }
  if (!target) {
    console.log(dim("已取消。"));
    return 1;
  }
  state.current = target.name;
  record(state, "use", target.name);
  saveState(state);
  console.log(green(`当前版本已设为 ${target.name}`));
  return 0;
}

export type StartOptions = {
  port?: number;
  map?: string;
  playlist?: string;
  visibility?: Visibility;
  auth?: AuthMode;
  password?: string;
  hostname?: string;
  foreground?: boolean;
  noRestart?: boolean;
  force?: boolean;
  /** false = plain console window (no pipe tap, no log file) */
  hosted?: boolean;
  /** 日志守护该以什么 argv 重新进入 CLI；桌面端的宿主用 `R5_SERVER_DAEMON` 传进来。 */
  daemonCommand?: string[];
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

function effectiveSettings(state: State, opts: StartOptions): Settings {
  const s = { ...state.settings };
  if (opts.port !== undefined) s.port = opts.port;
  if (opts.map !== undefined) s.map = opts.map;
  if (opts.playlist !== undefined) s.playlist = opts.playlist;
  if (opts.visibility !== undefined) s.visibility = opts.visibility;
  if (opts.auth !== undefined) s.authMode = opts.auth;
  if (opts.password !== undefined) s.password = opts.password;
  if (opts.hostname !== undefined) s.hostname = opts.hostname;
  return s;
}

function buildArgs(s: Settings): string[] {
  const args = [
    "-dedicated",
    "-port",
    String(s.port),
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
  if (s.hostip.length > 0) args.push("+hostip", s.hostip);
  if (s.password.length > 0) args.push("+sv_password", s.password);
  if (s.playlist.length > 0) args.push("+launchplaylist", s.playlist);
  if (s.map.length > 0) args.push("+map", s.map);
  // 1v1 对战统计外发开关：引擎自述 `fs_stats_url` 置空即关闭，值是空串。
  if (s.statsUpload === "off") args.push("+fs_stats_url", "");
  // 公告轮播：引擎 cvar 默认 0（一条都不发，实测 `help bridge_chat_announce` → def. "0"）。
  if (s.announceRotate === "on") args.push("+bridge_chat_announce", "1");
  if (s.extra.length > 0) args.push(...s.extra.split(/\s+/).filter(Boolean));
  return args;
}

function runningProcessesFor(versionPath: string): win.ProcInfo[] {
  const prefix = versionPath.toLowerCase().replace(/\\+$/, "");
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

/** runid = 文件名末尾的 `YYYYMMDD-HHMMSS`（列表显示它，`logs --run` 也接受它）。 */
export function shardRunId(name: string): string {
  const match = /(\d{8}-\d{6})\.log$/.exec(name);
  return match ? match[1] : name.replace(/\.log$/, "");
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

/** 只保留最新 `keep` 个分片（按**文件名字典序**= 时间序）；删除失败只告警。 */
function pruneLogShards(keep: number, keepPath: string): string[] {
  const byName = listLogShards(keepPath).toSorted((a, b) => (a.name < b.name ? -1 : 1));
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
      version: string;
      versionPath: string;
      pid: number;
      port: number;
      workingSetMB: number;
      privateMB: number;
      endpoints: string[];
      title: string;
      settings: Settings;
      logFile?: string;
      hosted: boolean;
      bound: boolean;
      /** 启动前为「面板值优先于 cfg」重写过的 cvar 行 */
      synced: CfgSync[];
      /** 不致命但要说出来的事（守护没起来、旧分片删不掉…） */
      warnings: string[];
    };

/**
 * 启动当前版本并返回结果；`report` 只收进度行（CLI 用来打印，面板传空）。
 * 前台模式（`foreground`）是 CLI 专属：它接管终端、会阻塞到进程退出。
 */
export async function startInstance(
  state: State,
  opts: StartOptions,
  report: (line: string) => void = () => {},
): Promise<StartOutcome> {
  const version = await ensureVersion(state, true);
  if (!version) return { ok: false, error: "没有选定版本目录。" };

  const settings = effectiveSettings(state, opts);
  const alive = runningProcessesFor(version.path);
  if (alive.length > 0 && !opts.force) {
    return {
      ok: false,
      error: `该版本已在运行（pid ${alive.map((p) => p.pid).join(", ")}）。`,
      hint: "如需重启：r5-server restart   /   强制再开一个：start --force",
    };
  }
  if (win.portInUse(settings.port) && !opts.force) {
    return {
      ok: false,
      error: `UDP ${settings.port} 已被占用（可能是别的实例）。`,
      hint: "换端口：start --port 37016   或强制：--force",
    };
  }

  const exePath = join(version.path, EXE);
  const args = buildArgs(settings);
  const env = { ...process.env, VPROJECT: "1", FROM_R5F_LAUNCHER: "1" } as Record<string, string>;
  const warnings: string[] = [];

  let logdPid: number | undefined;
  let logFile: string | undefined;
  let tapPidFile: string | undefined;
  let ctlPortValue = 0;
  let ctlTokenValue = "";
  if (opts.hosted !== false) {
    logDir(ROOT);
    const names = makeTapNames();
    const candidateLog = join(logDir(ROOT), logShardName(version.name, settings.port, new Date()));
    const pidFile = join(logDir(ROOT), `.tap-${names.id}.pid`);
    const ctlToken = randomUUID().replace(/-/g, "");
    const daemon = Bun.spawn({
      cmd: (opts.daemonCommand ?? selfCommand([])).concat([
        "__logd",
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
      report("已启用托管控制台（日志会写入文件并可用 r5-server logs -f 实时查看）");
      // 保留最近 N 次运行的分片（`logRetention` 是本机工具设置，不传给引擎）。
      const failed = pruneLogShards(Math.max(1, state.settings.logRetention ?? 10), candidateLog);
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

  // autoexec_server.cfg runs after the launch arguments: rewrite the cvars it
  // shares with the panel so the panel's values are the effective ones.
  const synced = syncLaunchSettings(version.path, settings);

  const before = new Set(win.findDediProcesses().map((p) => p.pid));
  const child = Bun.spawn({
    cmd: [exePath, ...args],
    cwd: version.path,
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();

  report("等待实例就绪（加载地图通常 10-30 秒）...");
  const { proc, bound } = await waitForStarted(version.path, settings.port, before);
  if (!proc) {
    return {
      ok: false,
      error: "30 秒内没有出现服务端进程。",
      hint: "排查：三件套是否齐全（r5-server doctor）、端口是否被占、杀软是否拦截 loader.dll。",
    };
  }
  state.runtime = {
    pid: proc.pid,
    port: settings.port,
    version: version.name,
    startedAt: new Date().toISOString(),
    logdPid,
    logFile,
    ctlPort: ctlPortValue || undefined,
    ctlToken: ctlTokenValue || undefined,
  };
  // `start` overrides are one-shot: the README promises 单次覆盖（不写回配置）,
  // and `settings` is the surface that persists.
  record(state, "start", `${version.name} port=${settings.port} map=${settings.map} hosted=${Boolean(logFile)}`);
  saveState(state);
  if (tapPidFile) {
    await Bun.write(tapPidFile, String(proc.pid));
  }

  return {
    ok: true,
    version: version.name,
    versionPath: version.path,
    pid: proc.pid,
    port: settings.port,
    workingSetMB: proc.workingSetMB,
    privateMB: proc.privateMB,
    endpoints: win.udpEndpoints(proc.pid),
    title: proc.title,
    settings,
    logFile,
    hosted: Boolean(logFile),
    bound,
    synced,
    warnings,
  };
}

/** 前台模式（CLI 专属）：接管终端、Ctrl+C 结束，可选退出后自动重启。 */
async function runForeground(state: State, opts: StartOptions): Promise<number> {
  const version = await ensureVersion(state, true);
  if (!version) return 1;
  const settings = effectiveSettings(state, opts);
  const env = { ...process.env, VPROJECT: "1", FROM_R5F_LAUNCHER: "1" } as Record<string, string>;
  console.log(dim("前台模式，Ctrl+C 结束；退出后按需重启...\n"));
  for (;;) {
    const child = Bun.spawn({
      cmd: [join(version.path, EXE), ...buildArgs(settings)],
      cwd: version.path,
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await child.exited;
    console.log(yellow(`r5apex_ds 退出，退出码 ${code}`));
    if (opts.noRestart) break;
    console.log(dim("10 秒后重启..."));
    await Bun.sleep(10_000);
  }
  return 0;
}

export async function cmdStart(state: State, opts: StartOptions): Promise<number> {
  if (opts.foreground) return runForeground(state, opts);
  const result = await startInstance(state, opts, (line) => console.log(dim(line)));
  if (!result.ok) {
    console.log(red(result.error));
    if (result.hint) console.log(dim(`  ${result.hint}`));
    return 1;
  }

  header(`启动 ${result.version}`);
  kv("端口", `UDP ${result.port}`);
  kv("地图", result.settings.map || "(未指定)");
  kv("模式", result.settings.playlist || "(启动后由玩家选择)");
  kv("可见性", `${result.settings.visibility}  (0=离线 1=隐藏 2=公开)`);
  kv("认证", `sv_onlineAuthMode ${result.settings.authMode}`);
  kv("名称", result.settings.hostname);
  for (const warning of result.warnings) console.log(yellow(`  ${warning}`));
  for (const change of result.synced) {
    console.log(
      dim(`  已同步 ${change.file}: ${change.cvar} ${change.from} → "${change.to}"（否则 cfg 会覆盖面板设置）`),
    );
  }
  if (result.logFile) kv("本次日志", result.logFile);
  console.log(green(`\n已启动：pid ${result.pid}`));
  kv("内存", `${result.workingSetMB} MB 工作集 / ${result.privateMB} MB 私有提交`);
  kv("监听 UDP", result.endpoints.join(", "));
  if (result.title) kv("窗口标题", result.title);
  if (!result.bound) {
    console.log(yellow(`  注意：进程在跑但 30 秒内没看到 UDP ${result.port} 绑定，稍后用 status 复查。`));
  }
  console.log(dim(`  玩家加入：R5F launcher -> connect <公网IP>:${result.port}`));
  return 0;
}

/** 停掉实例：进程树 + 日志守护；`all` 连本目录下其它实例一起停。 */
export function stopInstance(state: State, opts: { all?: boolean } = {}): { killed: number } {
  let killed = 0;
  const runtime = state.runtime;
  if (runtime?.pid) {
    const info = win.getProcess(runtime.pid);
    if (info) {
      if (win.killTree(info.pid)) killed++;
    }
  }
  if (runtime?.logdPid && isPidAlive(runtime.logdPid)) {
    try {
      process.kill(runtime.logdPid);
      killed++;
    } catch {
      /* already gone */
    }
  }
  if (opts.all) {
    for (const p of win.findDediProcesses()) {
      if (p.path.toLowerCase().startsWith(ROOT.toLowerCase()) && win.killTree(p.pid)) killed++;
    }
  }
  state.runtime = null;
  record(state, "stop", `killed=${killed}`);
  saveState(state);
  return { killed };
}

export function cmdStop(state: State, opts: { all?: boolean } = {}): number {
  const { killed } = stopInstance(state, opts);
  console.log(killed > 0 ? green(`已停止 ${killed} 个进程。`) : dim("没有正在运行的实例。"));
  return 0;
}

export async function cmdStatus(state: State, opts: { watch?: boolean } = {}): Promise<number> {
  const render = async (): Promise<void> => {
    header("运行状态");
    printSections(await collectDetail(state));
  };

  if (!opts.watch) {
    await render();
    return 0;
  }
  for (;;) {
    process.stdout.write("\u001b[2J\u001b[H");
    await render();
    console.log(dim("\n每 3 秒刷新，Ctrl+C 退出"));
    await Bun.sleep(3000);
  }
}

export type UpgradeOptions = { to?: string; yes?: boolean; carry?: "none" | "config" | "all" };

function backupOperatorFiles(from: VersionInfo, stamp: string): string {
  const dest = join(BACKUP_DIR, stamp, from.name);
  for (const item of OPERATOR_FILES) {
    const src = join(from.path, item.path);
    if (!existsSync(src)) continue;
    const target = join(dest, item.path);
    mkdirSync(join(target, ".."), { recursive: true });
    cpSync(src, target, { recursive: Boolean(item.dir) });
  }
  return dest;
}

function carryOperatorFiles(from: VersionInfo, to: VersionInfo, carry: "none" | "config" | "all"): string[] {
  if (carry === "none") return [];
  const moved: string[] = [];
  for (const item of OPERATOR_FILES) {
    if (item.dir && carry !== "all") continue;
    const src = join(from.path, item.path);
    if (!existsSync(src)) continue;
    const dest = join(to.path, item.path);
    mkdirSync(join(dest, ".."), { recursive: true });
    cpSync(src, dest, { recursive: Boolean(item.dir), force: true });
    moved.push(item.path);
  }
  return moved;
}

export async function cmdUpgrade(state: State, opts: UpgradeOptions): Promise<number> {
  const versions = discoverVersions(ROOT);
  if (versions.length === 0) {
    console.log(red("没有可用版本目录。"));
    return 1;
  }
  const current = currentVersion(state);
  const carry: "none" | "config" | "all" = opts.carry ?? "config";

  let target: VersionInfo | null = null;
  if (opts.to) {
    target = findByNameOrVersion(opts.to);
    if (!target) {
      console.log(red(`找不到目标版本「${opts.to}」。`));
      return 1;
    }
  } else {
    const newer = versions.filter((v) => v.name !== current?.name && isNewer(v, current));
    const pool = newer.length > 0 ? newer : versions.filter((v) => v.name !== current?.name);
    if (pool.length === 0) {
      console.log(yellow("没有其他版本目录可供升级。"));
      return 1;
    }
    if (newer.length === 0) console.log(dim("未发现比当前更新的版本号，下面列出所有其他版本。"));
    target = await choose(
      "升级到哪个版本",
      pool.map((v) => ({ label: v.name, note: describe(v), value: v })),
    );
    if (!target) {
      console.log(dim("已取消。"));
      return 1;
    }
  }

  header("升级计划");
  kv("当前版本", current ? current.name : dim("未设置"));
  kv("目标版本", `${bold(target.name)}  ${dim(describe(target))}`);
  kv("备份位置", join(BACKUP_DIR, "<时间戳>", current?.name ?? "none"));
  kv("迁移内容", carryLabel(carry));

  if (current) {
    if (current.name === target.name) {
      console.log(yellow("目标版本与当前版本相同，仅会重新指向并迁移配置。"));
    }
    if (win.findDediProcesses().some((p) => p.path.toLowerCase().startsWith(current.path.toLowerCase()))) {
      console.log(yellow("旧版本仍在运行，升级后需要 stop / start 才会生效。"));
    }
  }

  if (!opts.yes && !(await confirm("确认执行？", true))) {
    console.log(dim("已取消。"));
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (current) {
    const backupPath = backupOperatorFiles(current, stamp);
    console.log(green(`已备份旧版本运维文件 → ${backupPath}`));
  }
  const carried = current ? carryOperatorFiles(current, target, carry) : [];
  if (carried.length > 0) {
    console.log(green(`已迁移 ${carried.length} 项：${carried.join(", ")}`));
  } else if (carry !== "none") {
    console.log(dim("没有需要迁移的运维文件（旧版本目录下不存在对应文件）。"));
  }

  state.current = target.name;
  state.runtime = null;
  record(state, "upgrade", `${current?.name ?? "none"} -> ${target.name} carry=${carry} backup=${stamp}`);
  saveState(state);

  console.log("");
  console.log(green(`当前版本已切换为 ${target.name}。`));
  console.log(dim("  下一步：r5-server restart   （或 stop 后 start）"));
  return 0;
}

function carryLabel(carry: "none" | "config" | "all"): string {
  if (carry === "none") return "不迁移（只切换版本）";
  if (carry === "all") return "配置 + mods 目录";
  return "仅运维配置（cfg / 播放列表 / 地图清单）";
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

function ensureScheduledTask(opts: SetupOptions): void {
  if (opts.noTask) {
    console.log(dim("  跳过计划任务"));
    return;
  }
  const taskName = opts.taskName ?? "R5F Dedicated Server";
  const commandLine = taskCommandLine(["start", "--detach"]);
  if (opts.dryRun) {
    console.log(`  [预演] 将创建计划任务「${taskName}」：登录时运行 ${commandLine}`);
    return;
  }
  const r = win.ps(
    `schtasks.exe /Create /TN ${win.psQuote(taskName)} /TR ${win.psQuote(commandLine)} /SC ONLOGON /RL HIGHEST /F | Out-Null; 'ok'`,
  );
  console.log(
    r.out.includes("ok")
      ? green(`  计划任务已创建：${taskName}（登录时启动）`)
      : red(`  计划任务创建失败：${r.err || r.out}`),
  );
}

export async function cmdSetup(state: State, opts: SetupOptions, rawArgs: string[]): Promise<number> {
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
  const ports = (opts.ports && opts.ports.length > 0 ? opts.ports : [state.settings.port]).filter(
    (p) => Number.isFinite(p) && p > 0 && p <= 65535,
  );
  console.log(dim(`  根目录：${ROOT}`));
  console.log(dim(`  端口：${ports.join(", ")}${opts.dryRun ? "（预演：不会真正修改）" : ""}`));
  if (opts.noFirewall) console.log(dim("  跳过防火墙规则"));
  else ports.forEach((p) => ensureFirewall(p, Boolean(opts.dryRun)));
  configurePageFile(opts);
  const versionPaths = discoverVersions(ROOT, { withSizes: false }).map((v) => v.path);
  ensureDefenderExclusions(opts, versionPaths);
  ensureScheduledTask(opts);
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
  record(state, "setup", `ports=${ports.join(",")} dryRun=${Boolean(opts.dryRun)}`);
  saveState(state);
  return 0;
}

export type SettingChange = { id: FieldId; raw: string };

/** Print every launch setting the way the settings page shows it. */
function printSettingsTable(state: State): void {
  header("当前设置");
  const width = Math.max(...SETTINGS_FIELDS.map((f) => stringWidth(f.label))) + 2;
  for (const field of SETTINGS_FIELDS) {
    const value = field.display(state.settings);
    const isDefault = state.settings[field.id] === field.defaultValue;
    const engine = field.engineName ? dim(`  ${field.engineName}`) : "";
    kv(padEndWidth(field.label, width), `${isDefault ? dim(value) : green(value)}${engine}`);
  }
  console.log("");
  console.log(dim(`  改动：r5-server settings --hostname "我的服" --map mp_rr_district --visibility 2`));
  console.log(dim(`  交互式改动：面板里按 g 打开「游戏设置」`));
  console.log(dim(`  文件：${join(ROOT, "r5-server.json")}`));
  console.log(dim("  所有设置都是启动参数，改完需要重启服务器才生效。"));
}

/**
 * Persist validated changes. Every surface (CLI flag, settings page) funnels
 * through the field table, so a value accepted in one place is accepted in all.
 */
export type SettingsOutcome = { applied: string[]; failed: string[] };

/**
 * 应用一批设置改动（唯一入口：CLI、面板都走这里）。返回逐条结果，不打印。
 * 改动会同步写回正在生效的档案，档案与生效值不会漂移。
 */
export function saveSettings(state: State, changes: SettingChange[]): SettingsOutcome {
  const applied: string[] = [];
  const failed: string[] = [];
  for (const change of changes) {
    const field = fieldById(change.id);
    const parsed = applyFieldValue(state.settings, change.id, change.raw);
    if (!parsed.ok) {
      failed.push(`${field.label}：${parsed.error}`);
      continue;
    }
    applied.push(`${field.label} = ${field.display(state.settings)}`);
  }
  if (applied.length > 0) {
    record(state, "settings", applied.join("; "));
    syncActiveProfile(state);
    saveState(state);
  }
  return { applied, failed };
}

export async function cmdSettings(state: State, changes: SettingChange[]): Promise<number> {
  if (changes.length === 0) {
    printSettingsTable(state);
    return 0;
  }
  const { applied, failed } = saveSettings(state, changes);
  applied.forEach((line) => console.log(green(`  已保存  ${line}`)));
  failed.forEach((line) => console.log(red(`  未保存  ${line}`)));
  if (failed.length > 0) {
    console.log(dim("\n  取值说明见：r5-server settings（不带参数）"));
    return 1;
  }
  console.log(dim("\n  重启服务器后生效：r5-server restart"));
  return 0;
}

/**
 * Apply one setting in-process (used by the settings page). State is reloaded
 * first so a concurrent CLI write is never clobbered.
 */
export function applySettingInPlace(id: FieldId, raw: string): { ok: boolean; error?: string; text: string } {
  const field = fieldById(id);
  const state = loadState();
  const parsed = applyFieldValue(state.settings, id, raw);
  if (!parsed.ok) return { ok: false, error: parsed.error, text: "" };
  record(state, "settings", `${field.label}=${field.display(state.settings)}`);
  syncActiveProfile(state);
  saveState(state);
  return { ok: true, text: `${field.label} = ${field.display(state.settings)}` };
}

/** Newest log file for a version, by mtime（当前实例没有 logFile 时回退到它）。 */
function newestLogFile(versionName: string | null): string | null {
  const dir = join(ROOT, "logs");
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith(".log"))
    .filter((f) => !versionName || f.startsWith(`${versionName}-`))
    .map((f) => join(dir, f));
  if (candidates.length === 0) return null;
  return candidates.map((p) => ({ p, m: statSync(p).mtimeMs })).toSorted((a, b) => b.m - a.m)[0].p;
}

export type LogsOptions = { lines?: number; follow?: boolean; all?: boolean; run?: string };

/** `logs --all`：列出全部分片（最新在前，标出本次运行）。 */
function listRuns(state: State): number {
  header("运行日志分片");
  const shards = listLogShards(state.runtime?.logFile);
  if (shards.length === 0) {
    console.log(yellow("  还没有日志文件。"));
    console.log(dim("  日志只在「托管控制台」模式下产生：r5-server start 默认开启。"));
    console.log(dim(`  目录：${join(ROOT, "logs")}`));
    return 1;
  }
  console.log(bold("  分片（最新在前）："));
  for (const shard of shards) {
    const mark = shard.current ? green("  ← 本次运行") : "";
    console.log(`  ${bold(shard.name)}${mark}`);
    console.log(
      `      ${dim(`${formatSize(shard.size)}  ${new Date(shard.mtime).toLocaleString()}  run ${shardRunId(shard.name)}`)}`,
    );
  }
  console.log(dim(`\n  读取某次运行：r5-server logs --run <runid|文件名>   目录：${join(ROOT, "logs")}`));
  return 0;
}

/** `logs --run <runid|文件名>`：读指定分片的尾部。 */
function readRun(state: State, key: string, lines: number): number {
  const shards = listLogShards(state.runtime?.logFile);
  const wantedName = key.endsWith(".log") ? key : undefined;
  const target = shards.find((shard) => shard.name === wantedName || shardRunId(shard.name) === key);
  header("服务器日志");
  if (!target) {
    console.log(red(`  找不到日志分片「${key}」。`));
    const available = shards.map((shard) => shard.name);
    console.log(dim(available.length > 0 ? `  可选：${available.join(", ")}` : "  logs/ 下还没有分片。"));
    return 1;
  }
  kv("文件", target.path);
  kv("运行", `${shardRunId(target.name)}${target.current ? "（本次运行）" : "（历史运行）"}`);
  const initial = readTail(target.path, lines);
  if (initial.length === 0) console.log(dim("  (文件还是空的)"));
  for (const line of initial) console.log(stripAnsi(line));
  return 0;
}

/**
 * Print (and optionally follow) the hosted-console log. With the tap active
 * this is the engine's own output; without it, the file simply stays empty and
 * the console window is the source of truth.
 */
export async function cmdLogs(state: State, opts: LogsOptions): Promise<number> {
  if (opts.all) return listRuns(state);
  if (opts.run) return readRun(state, opts.run, opts.lines ?? 40);
  const version = currentVersion(state);
  const file =
    state.runtime?.logFile && existsSync(state.runtime.logFile)
      ? state.runtime.logFile
      : newestLogFile(version?.name ?? state.current);
  header("服务器日志");
  if (!file) {
    console.log(yellow("  还没有日志文件。"));
    console.log(dim("  日志只在「托管控制台」模式下产生：r5-server start 默认开启。"));
    console.log(dim(`  目录：${join(ROOT, "logs")}`));
    return 1;
  }
  kv("文件", file);
  if (state.runtime?.logFile && file !== state.runtime.logFile) {
    console.log(yellow("  注意：这是本版本最近的一份日志，不是当前运行实例的（当前实例未启用托管控制台）。"));
  }
  const lines = opts.lines ?? 40;
  const initial = readTail(file, lines);
  if (initial.length === 0) console.log(dim("  (文件还是空的，等服务端开始输出)"));
  for (const line of initial) console.log(stripAnsi(line));

  if (!opts.follow) return 0;
  console.log(dim("\n--- 实时跟随中，Ctrl+C 退出 ---"));
  let size = existsSync(file) ? statSync(file).size : 0;
  for (;;) {
    await Bun.sleep(400);
    if (!existsSync(file)) continue;
    const now = statSync(file).size;
    if (now < size) size = 0; // rotated/truncated
    if (now === size) continue;
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(now - size);
      readSync(fd, buffer, 0, buffer.length, size);
      size = now;
      const text = buffer.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue;
        console.log(stripAnsi(line));
      }
    } finally {
      closeSync(fd);
    }
  }
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
 * Command line that re-enters this CLI, quoted for `schtasks /TR`.
 * Running from source the executable is bun, so the script must be included.
 */
function taskCommandLine(extraArgs: string[]): string {
  return selfCommand(extraArgs)
    .map((part) => (part.includes(" ") ? `"${part}"` : part))
    .join(" ");
}

export async function cmdAutostart(state: State, opts: AutostartOptions, rawArgs: string[]): Promise<number> {
  const taskName = opts.taskName ?? DEFAULT_TASK;
  header(`开机自启：${opts.action}`);
  if (opts.dryRun) {
    const trigger = opts.trigger === "startup" ? "ONSTART" : "ONLOGON";
    console.log(dim("  [预演] 不会修改系统"));
    kv("任务名", taskName);
    kv("触发", trigger === "ONLOGON" ? "用户登录时" : "开机时");
    kv(
      "命令",
      taskCommandLine(["start", "--detach", ...(opts.extraArgs ? opts.extraArgs.split(/\s+/).filter(Boolean) : [])]),
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
      console.log(dim("  开启：r5-server autostart enable"));
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
    console.log(dim("  触发后由 CLI 拉起服务端；想立刻验证可执行：r5-server autostart run"));
    return 0;
  }
  if (opts.action === "disable") {
    const r = win.ps(`schtasks.exe /Delete /TN ${win.psQuote(taskName)} /F 2>&1 | Out-Null; 'ok'`);
    console.log(r.out.includes("ok") ? green(`  已删除计划任务「${taskName}」`) : red(`  删除失败：${r.err || r.out}`));
    record(state, "autostart", `disable ${taskName}`);
    saveState(state);
    return 0;
  }
  if (opts.action === "run") {
    const r = win.ps(`schtasks.exe /Run /TN ${win.psQuote(taskName)} 2>&1 | Out-Null; 'ok'`);
    console.log(r.out.includes("ok") ? green(`  已触发「${taskName}」`) : red(`  触发失败：${r.err || r.out}`));
    return 0;
  }
  // enable
  const commandLine = taskCommandLine([
    "start",
    "--detach",
    ...(opts.extraArgs ? opts.extraArgs.split(/\s+/).filter(Boolean) : []),
  ]);
  const trigger = opts.trigger === "startup" ? "ONSTART" : "ONLOGON";
  const r = win.ps(
    `schtasks.exe /Create /TN ${win.psQuote(taskName)} /TR ${win.psQuote(commandLine)} /SC ${trigger} /RL HIGHEST /F | Out-Null; 'ok'`,
  );
  if (!r.out.includes("ok")) {
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
  record(state, "autostart", `enable ${taskName} trigger=${trigger}`);
  saveState(state);
  return 0;
}

export async function cmdDoctor(state: State): Promise<number> {
  const { sections, problems } = await collectDoctor(state);
  header("环境体检");
  printSections(sections);
  console.log("");
  if (problems.length === 0) {
    console.log(green("  没有发现明显问题。"));
  } else {
    console.log(yellow("  待处理："));
    problems.forEach((problem) => console.log(`    - ${problem}`));
  }
  console.log(dim("\n  别忘了：云防火墙（腾讯云轻量控制台）也要放行同样的 UDP 端口才会对外可达。"));
  return problems.length === 0 ? 0 : 1;
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

/** 实例不是用托管控制台启动的：没有 `ctlPort`/令牌（CLI 映射到退出码 2）。 */
export class NoControlChannelError extends Error {
  constructor(message = NO_CONTROL_MESSAGE) {
    super(message);
    this.name = "NoControlChannelError";
  }
}

/** 没有托管控制台时的统一文案（CLI、面板共用）。 */
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
  const runtime = state.runtime;
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

/** 回执的中文结论（CLI 与面板共用同一套文案）。 */
export function receiptLabel(receipt: Receipt): string {
  return RECEIPT_LABELS[receipt.kind](receipt);
}

export type ConVarRead = { found: boolean; value: string | null; lines: string[] };

/**
 * `help <name>` 的回显（实测 1.0.13 三种形态）：
 *   `"bridge_chat_announce" = "1" ( def. "0" ) release  - …`   —— 设过值
 *   `"bridge_chat_announce" = "0" release               - …`   —— 等于默认值（没有 def 段）
 *   `"ban"  release  - Bans a client … ( ban <userId> )`        —— 是命令，不是 cvar
 * 值必须紧跟在 `=` 后面（引号里取到闭引号为止），别把后面的描述文字一起吃进来。
 */
const CONVAR_VALUE = /^"([A-Za-z0-9_]+)"\s*=\s*(?:"([^"]*)"|(\S+))/;

/**
 * 读一个 cvar 的当前值。引擎没有"打印 cvar"的独立命令，但 `help <name>` 会连值一起回，
 * 而且 `help` 查不到时会明确说 `help:  no cvar or command named x`（实测）—— 这就是回执。
 */
export async function readConVar(state: State, name: string, waitMs = 1200): Promise<ConVarRead> {
  const receipt = await consoleWithReceipt(state, `help ${name}`, waitMs);
  for (const line of receipt.lines) {
    const match = CONVAR_VALUE.exec(line.trim());
    if (match && match[1] === name) return { found: true, value: match[2] ?? match[3] ?? "", lines: receipt.lines };
  }
  return { found: false, value: null, lines: receipt.lines };
}

export type ConVarWrite = { ok: boolean; before: string | null; after: string | null; sent: Receipt };

/**
 * 写一个 cvar 并**读回确认**：赋值本身引擎一个字都不回（实测 `bridge_chat_announce 1`
 * 静默），所以"发送成功"不能当"值确实变了"。这里设完再读一次，值不等就不算成功。
 */
export async function setConVar(state: State, name: string, value: string): Promise<ConVarWrite> {
  const before = await readConVar(state, name);
  const sent = await consoleWithReceipt(state, `${name} ${value}`);
  const after = await readConVar(state, name);
  return { ok: after.found && after.value === value, before: before.value, after: after.value, sent };
}

/** 静默是暗色，不是绿色：它只说明"发出去了"。 */
const RECEIPT_TONE: Record<ReceiptKind, (text: string) => string> = {
  success: green,
  unknown: red,
  usage: red,
  silent: dim,
};

/** 发送一条命令、打印回执结论，返回 CLI 退出码（0/1/2）。 */
async function sendWithReceipt(
  state: State,
  line: string,
  opts: { json?: boolean; waitMs?: number; suffix?: string } = {},
): Promise<number> {
  let receipt: Receipt;
  try {
    receipt = await consoleWithReceipt(state, line, opts.waitMs);
  } catch (err) {
    if (err instanceof NoControlChannelError) {
      console.log(red(`  ${err.message}`));
      console.log(dim("  用 r5-server restart 以托管模式重启后重试。"));
      return 2;
    }
    console.log(red(`  ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }
  if (opts.json) {
    console.log(
      JSON.stringify({ command: line, kind: receipt.kind, detail: receipt.detail, lines: receipt.lines }, null, 2),
    );
  } else {
    console.log(RECEIPT_TONE[receipt.kind](receiptLabel(receipt)));
    // 引擎回了内容但没命中我们认识的模式：原样给出来，别让操作者猜。
    if (receipt.kind === "silent") for (const extra of receipt.lines) console.log(dim(`    ${extra}`));
    if (opts.suffix) console.log(dim(`  ${opts.suffix}`));
  }
  return receipt.kind === "success" || receipt.kind === "silent" ? 0 : 1;
}

export type ConsoleOptions = { json?: boolean; waitMs?: number };

/** Run one or more console commands on the running instance, with receipts. */
export async function cmdConsole(state: State, command: string[], opts: ConsoleOptions = {}): Promise<number> {
  const line = command.join(" ").trim();
  if (line.length === 0) {
    console.log(red("用法：r5-server console <命令…>，例如 r5-server console status"));
    return 1;
  }
  const logFile = state.runtime?.logFile;
  return sendWithReceipt(state, line, {
    json: opts.json,
    waitMs: opts.waitMs,
    suffix: logFile ? `输出见日志：${logFile}（r5-server logs -f）` : undefined,
  });
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
  const runtime = state.runtime;
  if (!runtime?.ctlPort || !runtime.ctlToken)
    return { header: [], players: [], error: "没有控制通道（需托管控制台启动）" };
  const reply = await controlSend(runtime.ctlPort, runtime.ctlToken, ["status"]);
  if (!reply.ok) return { header: [], players: [], error: reply.reason ?? "发送失败" };
  await Bun.sleep(900);
  if (!runtime.logFile || !existsSync(runtime.logFile)) return { header: [], players: [] };
  return parseStatusBlock(readTail(runtime.logFile, 200));
}

export async function cmdPlayers(state: State, opts: { json?: boolean } = {}): Promise<number> {
  const result = await fetchPlayers(state);
  if (result.error) {
    console.log(red(`  ${result.error}`));
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify(result.players, null, 2));
    return 0;
  }
  header("在线玩家");
  result.header.forEach((line) => console.log(dim(`  ${line}`)));
  if (result.players.length === 0) {
    console.log(yellow("\n  当前没有玩家在线。"));
    return 0;
  }
  console.log("");
  console.log(bold("  userid  id64              ping  loss  状态        名字"));
  for (const player of result.players) {
    console.log(
      `  ${player.userid.padStart(6)}  ${player.uniqueid.padEnd(16)}  ${player.ping.padStart(4)}  ${player.loss.padStart(4)}  ${player.state.padEnd(10)}  ${player.name}`,
    );
  }
  console.log(dim("\n  踢人：r5-server kick <userid|id64>   封禁：r5-server ban <userid|id64>"));
  return 0;
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
      hint: "没有向引擎发送任何封禁指令（只读查了在线名单）。查名单：r5-server players",
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
    return { ok: false, error: `用法：r5-server ${action} <userid|id64>`, exitCode: 1 };
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

/**
 * Kick/ban/unban by userid or id64（ticket 03 冻结的形式）。
 *
 * 实测补充（本机 r5f-dedi 1.0.13 托管实例）：`kick "<userid>"` 对机器人静默且不生效，
 * 而 `kick "<玩家名>"` 回 `Kicked '…' from server`。这里保持 ticket 的形式不动，
 * 但"静默"就如实说静默；`bots clear` 里补了按名字重试的回退。
 *
 * 封禁的时长/原因（ticket 03 当时判定"做不了"）现在由本机台账兑现：命令层仍然是引擎那条
 * `ban "<target>"`（引擎没有别的形式，实测 `help ban` → `ban <userId>`），时长/原因/到期
 * 记在 `moderation.json` 里，到期由日志守护发 `unban`。
 */
export async function cmdModerate(
  state: State,
  action: "kick" | "ban" | "unban",
  target: string,
  opts: ModerateOptions = {},
): Promise<number> {
  const result = await moderate(state, action, target, opts);
  if (result === "no-control") {
    console.log(red(`  ${NO_CONTROL_MESSAGE}`));
    return 2;
  }
  if (!result.ok) {
    console.log(red(`  ${result.error}`));
    if (result.hint) console.log(dim(`  ${result.hint}`));
    return result.exitCode;
  }
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          action: result.action,
          target: target.trim(),
          id64: result.entry?.id64 ?? null,
          name: result.entry?.name ?? null,
          minutes: result.entry?.minutes ?? null,
          reason: result.entry?.reason ?? null,
          expiresAt: result.entry && result.entry.expiresAt > 0 ? new Date(result.entry.expiresAt).toISOString() : null,
          receipt: { kind: result.receipt.kind, detail: result.receipt.detail },
        },
        null,
        2,
      ),
    );
    return 0;
  }
  console.log(RECEIPT_TONE[result.receipt.kind](result.label));
  if (result.action === "ban" && result.entry) {
    const entry = result.entry;
    console.log(green(`  已记入本机台账：${entry.name || entry.id64}（id64 ${entry.id64}）`));
    if (entry.minutes > 0) {
      console.log(dim(`  到期自动解封：${describeExpiry(entry, Date.now())}`));
      console.log(dim("  解封由日志守护在到期时发 `unban` —— 守护随实例存活；实例停着时不会执行。"));
    } else {
      console.log(dim("  永久封禁（无到期）。原因只记在本机，引擎不保存。"));
    }
    console.log(dim("  注意：引擎对 `ban` 不回话，所以这里只能说“命令已发出”，封没封上要玩家端确认。"));
  }
  if (result.action === "unban" && (result.released ?? 0) > 0) {
    console.log(dim(`  已把本机台账里 ${result.released} 条对应记录标为「已解除」。`));
  }
  return 0;
}

/**
 * 禁言：引擎里**没有**本地禁言命令 —— 实测 `help mute` → `no cvar or command named mute`，
 * `server.dll` 里也没有。通讯封禁是 R5F/Spire 平台侧的概念（全局聊天封禁名单，
 * 由 `sv_applyGlobalCommsBans` / `sv_commsBansAreGameBans` 决定怎么用），本地控制台无法给
 * 单个玩家打标记。所以这里如实拒绝，并把引擎那两个开关的当前值读出来给操作者看。
 */
export async function cmdMute(state: State, target: string | undefined): Promise<number> {
  const wanted = (target ?? "").trim();
  header("禁言（通讯封禁）");
  console.log("  引擎没有本地禁言命令：本机控制台发不出“只堵这个人的聊天”的指令。");
  console.log("  通讯封禁是 R5F 平台侧的全局聊天封禁名单，引擎只用两个开关决定怎么对待它：");
  const running = Boolean(state.runtime?.ctlPort && state.runtime.ctlToken);
  for (const [name, label] of [
    ["sv_applyGlobalCommsBans", "使用全局聊天封禁名单（0 无 / 1 文字 / 2 语音 / 3 两者）"],
    ["sv_commsBansAreGameBans", "把聊天封禁当成游戏封禁（0/1）"],
  ] as const) {
    if (!running) {
      kv(label, "实例未运行，读不到当前值");
      continue;
    }
    try {
      const read = await readConVar(state, name);
      kv(label, read.found ? `引擎回报 = "${read.value ?? ""}"` : "引擎没回这个 cvar（可能被版本移除）");
    } catch (err) {
      kv(label, err instanceof Error ? err.message : String(err));
    }
  }
  if (wanted.length === 0) {
    console.log(dim("\n  本机可用的处置：踢（kick）、封禁（ban，可带 --minutes/--reason）。"));
    return 0;
  }
  console.log(red(`\n  没有对「${wanted}」执行任何操作 —— 没有发送任何禁言指令（只读查了上面两个开关）。`));
  console.log(dim("  想让他闭嘴又不想踢人：只能等 R5F 平台侧的通讯封禁，或本地永久/临时封禁（ban）。"));
  return 1;
}

// -------------------------------------------------------------------- bots

/** 机器人判据：`status` 行里 `uniqueid === "0"`（实测机器人没有 id64）。 */
export async function fetchBots(state: State): Promise<{ bots: PlayerRow[]; error?: string }> {
  const result = await fetchPlayers(state);
  if (result.error) return { bots: [], error: result.error };
  return { bots: result.players.filter((player) => player.uniqueid === "0") };
}

export async function cmdBotsList(state: State, opts: { json?: boolean } = {}): Promise<number> {
  const result = await fetchBots(state);
  if (result.error) {
    console.log(red(`  ${result.error}`));
    console.log(dim("  机器人只能在托管控制台实例上看：r5-server restart 后重试。"));
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify(result.bots, null, 2));
    return 0;
  }
  header("机器人");
  if (result.bots.length === 0) {
    console.log(yellow("  当前没有机器人。"));
    console.log(dim("  加机器人：r5-server bots add --count 2"));
    return 0;
  }
  console.log(bold("\n  userid  状态        名字"));
  for (const bot of result.bots) {
    console.log(`  ${bot.userid.padStart(6)}  ${bot.state.padEnd(10)}  ${bot.name}`);
  }
  console.log(dim("\n  清空：r5-server bots clear"));
  return 0;
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
        hint: "要一批同款机器人：r5-server bots add --count 3（走 spawnbots）",
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

export async function cmdBotsAdd(state: State, opts: BotAddOptions = {}): Promise<number> {
  const result = await botsAdd(state, opts);
  if (result === "no-control") {
    console.log(red(`  ${NO_CONTROL_MESSAGE}`));
    return 2;
  }
  if (!result.ok) {
    console.log(red(`  ${result.error}`));
    if (result.hint) console.log(dim(`  ${result.hint}`));
    return result.exitCode;
  }
  console.log(RECEIPT_TONE[result.receipt.kind](result.label));
  if (result.receipt.kind === "unknown" || result.receipt.kind === "usage") return 1;
  console.log(dim("  新机器人会出现在：r5-server bots list"));
  return 0;
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

export async function cmdBotsClear(state: State): Promise<number> {
  const result = await botsClear(state);
  if (result === "no-control") {
    console.log(red(`  ${NO_CONTROL_MESSAGE}`));
    return 2;
  }
  if (!result.ok) {
    console.log(red(`  ${result.error}`));
    return result.exitCode;
  }
  header("清理机器人");
  if (result.before === 0) {
    console.log(green("  当前没有机器人，无需清理。"));
    return 0;
  }
  const cleaned = Math.max(0, result.before - result.remaining);
  console.log(green(`  已清理 ${cleaned} 个机器人（剩余 ${result.remaining}，引擎明确回执 ${result.confirmed} 次）`));
  if (result.remaining > 0) {
    console.log(yellow("  还有机器人没清掉：kick 生效与列表刷新之间有延迟（或引擎明确拒绝），再跑一次 bots clear。"));
  }
  if (result.refused > 0) console.log(red(`  ${result.refused} 次 kick 被引擎拒绝。`));
  return result.refused > 0 ? 1 : 0;
}

// ----------------------------------------------------------------- banlist

export type BanlistOptions = { reload?: boolean; json?: boolean };

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

/** banlist.json 的结构由引擎/Spire 侧决定 → 原样呈现键值，不硬编码 schema。 */
function printValues(value: unknown, indent: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      console.log(`${indent}${bold(`[${index + 1}]`)}`);
      printValues(item, `${indent}  `);
    });
    return;
  }
  const entries = asRecord(value);
  const keys = Object.keys(entries);
  if (keys.length === 0) {
    console.log(`${indent}${String(value)}`);
    return;
  }
  for (const key of keys) {
    const item = entries[key];
    if (typeof item === "object" && item !== null) {
      console.log(`${indent}${bold(key)}`);
      printValues(item, `${indent}  `);
    } else {
      console.log(`${indent}${dim(key)}: ${String(item)}`);
    }
  }
}

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

export async function cmdBanlist(state: State, opts: BanlistOptions = {}): Promise<number> {
  const result = await readBanlist(state, opts);
  if (result === "no-control") {
    console.log(red(`  ${NO_CONTROL_MESSAGE}`));
    console.log(dim("  用 r5-server restart 以托管模式重启后重试。"));
    return 2;
  }
  if (!result.ok) {
    console.log(red(`  ${result.error}`));
    return result.exitCode;
  }
  const { file, data: parsed, ledger, reload } = result.view;
  const now = Date.now();

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          path: file,
          reload: reload ? { kind: reload.kind, detail: reload.detail } : null,
          entries: parsed,
          local: { path: moderationPath(ROOT), entries: ledger },
          error: null,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (reload) console.log(RECEIPT_TONE[reload.kind](`  ${receiptLabel(reload)}`));

  header("封禁名单");
  printLedger(ledger, now);
  console.log("");
  if (!file) {
    console.log(dim("  引擎自己的封禁名单：本机还没有 banlist.json（引擎只在真正写入过封禁记录后才生成）。"));
    console.log(dim(`  查找过：${banlistCandidates(state).join("、")}`));
    console.log(dim("  让引擎重新加载名单：r5-server banlist --reload"));
    return 0;
  }
  kv("引擎名单文件", file);
  printValues(parsed, "  ");
  console.log(dim("\n  字段名由引擎决定，这里原样呈现，不做解释。"));
  return 0;
}

/** 本机台账：临时封禁的时长/原因/到期只有这里有（引擎不保存）。 */
function printLedger(entries: ModerationEntry[], now: number): void {
  console.log(bold("  本机封禁台账"));
  console.log(dim(`    ${moderationPath(ROOT)}（本工具记录；引擎不保存原因与到期）`));
  if (entries.length === 0) {
    console.log(dim("    还没有记录。带 --minutes/--reason 的 ban 会在这里留痕。"));
    return;
  }
  for (const entry of entries.slice(0, 20)) {
    const who = entry.name.length > 0 ? `${entry.name}（id64 ${entry.id64}）` : `id64 ${entry.id64}`;
    const kind = entry.minutes > 0 ? `临时 ${entry.minutes} 分钟` : "永久";
    const mark =
      entry.state === "unbanned"
        ? green("已解除")
        : entry.minutes > 0 && entry.expiresAt <= now
          ? yellow("到期未解封")
          : yellow("封禁中");
    console.log(`    ${mark} ${who} · ${kind} · ${describeExpiry(entry, now)}`);
    if (entry.reason.length > 0) console.log(dim(`      原因：${entry.reason}`));
  }
  if (entries.length > 20) console.log(dim(`    （还有 ${entries.length - 20} 条，见上面那个文件）`));
}

// ----------------------------------------------------------- announcements

/** CLI 传进来的原始字段（kind/color 的取值由 validateAnnouncement 判定）。 */
export type AnnouncementsRow = {
  kind?: string;
  tag?: string;
  text?: string;
  color?: string;
  sustain?: string;
  fade?: string;
  wait?: string;
};

export type AnnouncementsOptions = { json?: boolean; row?: AnnouncementsRow; index?: string };

/** 公告文案表（chat_announcements.csv）：list / add / remove。 */
export async function cmdAnnouncements(
  state: State,
  action: "list" | "add" | "remove",
  opts: AnnouncementsOptions = {},
): Promise<number> {
  const version = currentVersion(state);
  if (!version) {
    console.log(red("  未选择版本目录，无法定位 chat_announcements.csv。"));
    return 1;
  }
  const file = await collectAnnouncements(version.path);

  if (action === "list") {
    if (opts.json) {
      console.log(JSON.stringify({ path: file.path, rows: file.rows }, null, 2));
      return 0;
    }
    header("轮播公告");
    kv("文件", file.path);
    if (file.rows.length === 0) {
      console.log(yellow("\n  还没有公告文案。"));
      return 0;
    }
    console.log(bold("\n  #   kind     tag              color      wait  文案"));
    file.rows.forEach((row, index) => {
      console.log(
        `  ${String(index + 1).padStart(2)}  ${padEndWidth(row.kind, 8)} ${padEndWidth(row.tag, 16)} ${padEndWidth(row.color, 10)} ${padEndWidth(row.wait, 5)} ${row.text}`,
      );
    });
    console.log(dim("  改动在 changelevel 或重启后生效（引擎文件头自述）。"));
    console.log(
      dim('  新增：announcements add --text "…"   删除：announcements remove <序号>   轮播开关：announce on|off'),
    );
    return 0;
  }

  if (action === "add") {
    const kind = opts.row?.kind ?? "rotate";
    if (kind !== "rotate" && kind !== "welcome") {
      console.log(red(`  --kind 只能是 rotate / welcome，收到「${kind}」`));
      return 1;
    }
    const row: Announcement = {
      kind,
      tag: opts.row?.tag ?? "",
      text: opts.row?.text ?? "",
      color: opts.row?.color ?? "",
      sustain: opts.row?.sustain ?? "",
      fade: opts.row?.fade ?? "",
      wait: opts.row?.wait ?? "",
    };
    const problems = validateAnnouncement(row);
    if (problems.length > 0) {
      console.log(red("  未写入 —— 公告不合法："));
      problems.forEach((problem) => console.log(red(`    - ${problem}`)));
      return 1;
    }
    const rows = [...file.rows, row];
    writeFileSync(file.path, renderAnnouncements({ ...file, rows }), "utf8");
    console.log(green(`  已追加第 ${rows.length} 条（${file.path}）`));
    console.log(dim("  改动在 changelevel 或重启后生效（引擎文件头自述）；轮播开关：r5-server announce on"));
    return 0;
  }

  const index = Number.parseInt(opts.index ?? "", 10);
  if (!Number.isInteger(index) || index < 1 || index > file.rows.length) {
    console.log(red(`  remove 需要 1..${file.rows.length} 的序号（r5-server announcements list 可查）`));
    return 1;
  }
  const removed = file.rows[index - 1];
  const rows = file.rows.filter((_row, position) => position !== index - 1);
  writeFileSync(file.path, renderAnnouncements({ ...file, rows }), "utf8");
  console.log(green(`  已删除第 ${index} 条（${removed.kind} ${removed.text}）`));
  console.log(dim("  改动在 changelevel 或重启后生效（引擎文件头自述）。"));
  return 0;
}

/**
 * 公告轮播开关。
 *
 * 实测更正（本机 r5f-dedi 1.0.13，2026-09-15）：`bridge_chat_announce` 是**cvar**，不是命令 ——
 * `help bridge_chat_announce` 回 `"bridge_chat_announce" = "" ( def. "0" ) release - Broadcast
 * the rotating server chat announcements.`；引擎脚本 `sv_chat_announcements.nut` 里
 * `ChatAnnounce_Broadcast` / `ChatAnnounce_Loop` / `ChatAnnounce_OnClientConnected` 全都先查
 * `GetConVarBool("bridge_chat_announce")`，为假就整段不发。
 *
 * 旧的 `announce` 把 cvar 当命令发（一个裸名字就是一个赋值）→ 把值写成空串，等于把公告**关掉**，
 * 然后对外说"已广播"。本批改成真实的开关语义，并且写后读回确认（`help <cvar>` 会回当前值）。
 */
export type AnnounceAction = "status" | "on" | "off";

export async function cmdAnnounce(
  state: State,
  action: AnnounceAction = "status",
  opts: { json?: boolean } = {},
): Promise<number> {
  const runtime = state.runtime;
  const running = Boolean(runtime?.ctlPort && runtime.ctlToken);
  const setting = state.settings.announceRotate === "on" ? "开启" : "关闭（引擎默认）";

  if (action === "on" || action === "off") {
    if (!running) {
      console.log(red("  没有正在运行的实例：轮播开关是运行期 cvar，需要托管控制台。"));
      console.log(dim("  要长期开启：r5-server settings --announce-rotate on（下次启动生效）。"));
      return 2;
    }
    const want = action === "on" ? "1" : "0";
    let result: ConVarWrite;
    try {
      result = await setConVar(state, "bridge_chat_announce", want);
    } catch (err) {
      if (err instanceof NoControlChannelError) {
        console.log(red(`  ${err.message}`));
        return 2;
      }
      console.log(red(`  ${err instanceof Error ? err.message : String(err)}`));
      return 1;
    }
    if (opts.json) {
      console.log(
        JSON.stringify(
          { cvar: "bridge_chat_announce", want, before: result.before, after: result.after, ok: result.ok },
          null,
          2,
        ),
      );
      return result.ok ? 0 : 1;
    }
    if (!result.ok) {
      console.log(
        red(`  没有改成功：引擎回报 = ${result.after === null ? "(读不到)" : `"${result.after}"`}，期望 "${want}"`),
      );
      console.log(dim("  引擎原文："));
      result.sent.lines.forEach((line) => console.log(dim(`    ${line}`)));
      return 1;
    }
    console.log(green(`  已${action === "on" ? "开启" : "关闭"}公告轮播（引擎回报 = "${result.after}"）`));
    if (action === "on") {
      console.log(dim("  轮播会按文案表里的 wait 秒数逐条发；玩家进入时还会发欢迎语（kind=welcome）。"));
      console.log(dim("  文案改动需 changelevel 或重启后生效（引擎文件头自述）；效果要真人在场才看得到。"));
    }
    return 0;
  }

  let live: ConVarRead | null = null;
  let liveError = "";
  if (running) {
    try {
      live = await readConVar(state, "bridge_chat_announce");
    } catch (err) {
      liveError = err instanceof Error ? err.message : String(err);
    }
  }
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          cvar: "bridge_chat_announce",
          running,
          live: live?.found ? live.value : null,
          setting: state.settings.announceRotate,
          error: liveError.length > 0 ? liveError : null,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  header("公告轮播");
  kv(
    "引擎当前值",
    !running
      ? "实例未运行（读不到）"
      : liveError
        ? liveError
        : live?.found
          ? `引擎回报 = "${live.value}"`
          : "引擎没回这个 cvar",
  );
  kv("开机设置", setting);
  console.log("");
  console.log(dim("  开启时引擎会：① 按 kind=rotate 的文案逐条轮播；② 玩家进入时发 kind=welcome 的欢迎语。"));
  console.log(
    dim("  关闭（引擎默认）时一条都不发。运行期开关：r5-server announce on|off；长期：settings --announce-rotate on"),
  );
  console.log(dim("  文案改动在 changelevel 或重启后生效（引擎文件头自述）；广播效果需真人在场确认。"));
  return 0;
}

// -------------------------------------------------------------------- mode

export async function cmdModeList(state: State, opts: { json?: boolean } = {}): Promise<number> {
  const version = currentVersion(state);
  if (!version) {
    console.log(red("  未选择版本目录，无法读取模式清单。"));
    return 1;
  }
  const families = await collectModes(version.path);
  if (opts.json) {
    console.log(JSON.stringify(families, null, 2));
    return families.length > 0 ? 0 : 1;
  }
  header("模式清单");
  if (families.length === 0) {
    console.log(yellow("  playlists_r5_patch.txt 里没有带 r5f_mode_* 元数据的模式。"));
    return 1;
  }
  for (const family of families) {
    console.log("");
    console.log(bold(`  ${family.title}（${family.key}）`));
    for (const mode of family.modes) {
      const fallback = mode.map.length > 0 ? mode.map : (mode.maps[0] ?? "-");
      console.log(
        `    ${padEndWidth(mode.id, 24)} ${padEndWidth(mode.title, 16)} 地图 ${String(mode.maps.length).padStart(2)}  默认 ${fallback}`,
      );
    }
  }
  console.log(dim("\n  运行中热切：r5-server mode set <playlist> [map]（bridge_setmode）"));
  return 0;
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
  if (id.length === 0) return { ok: false, error: "用法：r5-server mode set <playlist> [map]", exitCode: 1 };
  if (!state.runtime?.ctlPort || !state.runtime.ctlToken) return "no-control";
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
  if (state.runtime) {
    const live = parseLiveLevel(receipt.lines);
    if (live) {
      // 回执里带着引擎真正的切换结果 —— 存起来，`status` 就不用拿启动设置冒充"当前"了。
      state.runtime.live = { ...live, at: new Date().toISOString() };
      record(state, "mode set", `${live.playlist} ${live.map}`);
      saveState(state);
    }
  }
  return { ok: true, playlist: id, map: chosenMap, mode, receipt };
}

export async function cmdModeSet(state: State, playlist: string, map?: string): Promise<number> {
  const result = await setLiveMode(state, playlist, map);
  if (result === "no-control") {
    console.log(red("  没有正在运行的实例：bridge_setmode 是运行期热切，需要先启动。"));
    console.log(dim(`  它不写启动设置；要长期固定：r5-server settings --playlist ${playlist.trim()} --map <map>`));
    return 2;
  }
  if (!result.ok) {
    console.log(red(`  ${result.error}`));
    return result.exitCode;
  }
  if (!result.mode) console.log(yellow(`  提示：「${result.playlist}」不在本地模式目录里，仍按你给的值发送。`));
  const { receipt } = result;
  console.log(RECEIPT_TONE[receipt.kind](receiptLabel(receipt)));
  if (receipt.kind === "silent") for (const extra of receipt.lines) console.log(dim(`    ${extra}`));
  if (receipt.kind === "success") {
    const live = parseLiveLevel(receipt.lines) ?? { playlist: result.playlist, map: result.map };
    console.log(dim(`  引擎已确认换图：模式 ${live.playlist} · 地图 ${live.map}（本次运行；改启动设置用 settings）`));
  } else if (receipt.kind === "silent") {
    console.log(dim("  引擎没有回确认行：换图是否成功要玩家端看实际地图，别按这里的话断言成功。"));
  }
  return receipt.kind === "success" || receipt.kind === "silent" ? 0 : 1;
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

// ------------------------------------------------------------------ health

export async function cmdHealth(state: State, opts: { json?: boolean } = {}): Promise<number> {
  const health = await collectHealth(state);
  const healthy = health.latestOk && health.error.bytes === 0;
  if (opts.json) {
    console.log(JSON.stringify(health, null, 2));
    return healthy ? 0 : 1;
  }
  header("本次运行健康");
  kv("运行 id", health.runId || "(读不到 latest.txt)");
  kv("目录", health.runDir || "-");
  const error = health.error;
  kv(
    "error.log",
    !error.exists
      ? "不存在"
      : error.bytes === 0
        ? green("空 —— 本次运行没有记录错误")
        : red(`${error.bytes < 1024 ? `${error.bytes} 字节` : formatSize(error.bytes)}，非空 —— 本次运行有错误`),
  );
  if (error.exists && error.bytes > 0) {
    error.lines.slice(0, 3).forEach((line) => console.log(red(`    ${line}`)));
  }
  kv(
    "warning.log",
    health.warning.exists ? `${health.warning.lines.length} 行（尾部采样，启动诊断噪音，不是错误）` : "不存在",
  );
  kv(
    "脚本告警",
    !health.scriptWarning.exists
      ? "script_warning.log 不存在"
      : health.scriptWarning.bytes === 0
        ? green("script_warning.log 存在且为空")
        : yellow(`script_warning.log 有 ${health.scriptWarning.lines.length} 行`),
  );
  console.log("");
  for (const note of health.notes) console.log(healthy ? dim(`  ${note}`) : yellow(`  ${note}`));
  return healthy ? 0 : 1;
}
