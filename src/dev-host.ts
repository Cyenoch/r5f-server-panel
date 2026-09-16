/**
 * 开发模式（R5F_DEV=1）的模拟主机。
 *
 * 面板的宿主是 Windows：进程表、UDP 端口、物理内存、防火墙、计划任务、电源计划
 * 全走 PowerShell/CIM。开发模式把这层整体换掉，让 CLI/TUI 能在 macOS 上跑真实交互
 * （真设置、真文件、真 TCP 控制通道），同时**绝不动真实系统**：查询读的是
 * `.dev/r5f` 下的假 JSON，写操作也只写那一个假文件。
 *
 * 三条约束：
 *   1. 假的引擎进程只有一条真信息 —— PID 是否还活着（`process.kill(pid, 0)`）。
 *      内存/CPU 只由快照里的启动时刻推出来（单调增长 + 一条固定正弦波动），
 *      所以同一时刻两次读到的值一致，但会随时间往前走：界面上的刷新是真的在动。
 *   2. 缺省一律「没配置」（页面文件未配、防火墙未放行、Defender 未排除、不是
 *      高性能、没有自启任务），这样主机配置页有东西可勾、体检页有东西可报。
 *   3. 端口占用只模拟快照里那一个 UDP 端口：不监听、不绑真实端口。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AutostartOptions, SetupOptions } from "./commands";
import { DEV_ROOT } from "./dev";
import { readDevEngineSnapshot, type DevEngineSnapshot } from "./dev-protocol";
import type { HostFacts } from "./inspect";
import { ROOT } from "./state";
import { isPidAlive, selfCommand } from "./tap";
import { dim, green, header, kv, yellow } from "./ui";
import { asRecord } from "./util";
import { discoverVersions } from "./versions";
import type { ProcInfo } from "./win";

const HOST_FILE = join(DEV_ROOT, "dev-host.json");

/** 模拟引擎在进程表里的名字，和真实服务端一致（状态页按它过滤）。 */
const DEDI_NAME = "r5apex_ds";
/** 计划任务默认名；inspect.ts / commands.ts 用的是同一个字面量。 */
const DEFAULT_TASK = "R5F Dedicated Server";

// ------------------------------------------------------------- json 取值护栏

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

/** 缺失 / 半截写入 / 不是 JSON，一律当「没有」：开发数据不值得让面板崩。 */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- engine snapshot

/**
 * 快照由引擎进程维护，读取与校验都在 dev-protocol.ts（单一真相来源）；
 * 这里只补一条真实条件：PID 得真的活着。
 */
function liveEngine(): DevEngineSnapshot | null {
  const snap = readDevEngineSnapshot();
  return snap !== null && isPidAlive(snap.pid) ? snap : null;
}

/**
 * 假进程信息。标题优先用引擎自己写进快照的那条（和真实引擎同格式），
 * 只有快照没带标题时才退回一条**不含假指标**的标题（宁可不显示，也不编造人数/地图）。
 */
function syntheticProc(snap: DevEngineSnapshot, nowMs: number): ProcInfo {
  const startedMs = Date.parse(snap.startedAt);
  // 快照时间戳坏掉时按「刚开始」算：假数据可以不准，但不该是 NaN。
  const elapsedSec = Number.isFinite(startedMs) ? Math.max(0, (nowMs - startedMs) / 1000) : 0;
  const workingSetMB = Math.round(1380 + Math.min(elapsedSec, 7200) / 6 + 120 * Math.sin(elapsedSec / 40));
  return {
    pid: snap.pid,
    workingSetMB,
    privateMB: Math.round(workingSetMB * 1.18),
    cpuSeconds: Math.round(elapsedSec * 0.35 + 6 * (1 - Math.cos(elapsedSec / 25))),
    title: snap.title.length > 0 ? snap.title : `${basename(snap.versionPath)} - 0/60 Players`,
    // 真实 ProcInfo.path 是版本目录里的可执行文件；状态页按 ROOT/版本目录前缀过滤。
    path: join(snap.versionPath, "r5apex_ds.exe"),
    startedAt: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : snap.startedAt,
  };
}

// ------------------------------------------------------------- win.ts 快路径

/** 模拟实例的进程信息；pid 不是当前实例就是 null。 */
export function devGetProcess(pid: number): ProcInfo | null {
  const snap = liveEngine();
  return snap !== null && snap.pid === pid ? syntheticProc(snap, Date.now()) : null;
}

export function devFindDediProcesses(name = DEDI_NAME): ProcInfo[] {
  if (name !== DEDI_NAME) return [];
  const snap = liveEngine();
  return snap === null ? [] : [syntheticProc(snap, Date.now())];
}

export function devUdpEndpoints(pid: number): string[] {
  const snap = liveEngine();
  return snap !== null && snap.pid === pid ? [`0.0.0.0:${snap.port}`] : [];
}

/** 只有快照里的那个端口，在实例活着时算占用。 */
export function devPortInUse(port: number): boolean {
  const snap = liveEngine();
  return snap !== null && snap.port === port;
}

export function devPhysicalRamGB(): number {
  return readDevHostState().ramGB;
}

/** 规则名与真实路径一致（`R5F dedi UDP <端口>`），只是命中集合来自假 JSON。 */
export function devFirewallRuleExists(displayName: string): boolean {
  const m = /^R5F dedi UDP (\d+)$/.exec(displayName);
  return m !== null && readDevHostState().firewallPorts.includes(Number(m[1]));
}

// ----------------------------------------------------------- 模拟主机状态文件

/**
 * 模拟主机「已配置了什么」。真实主机这些状态散落在防火墙 / CIM / 计划任务里；
 * 开发模式把它们收进一个假 JSON —— 每次 CLI 调用都是新进程，只有文件能跨进程记住
 * 主机配置页的勾选，这也正是验收里「配置改动要活过子进程」的那条。
 */
type DevHostState = {
  ramGB: number;
  pageInitMB: number;
  pageFileMaxMB: number;
  diskFreeGB: number;
  defenderExcluded: boolean;
  powerHighPerformance: boolean;
  taskName: string;
  taskState: string;
  taskTrigger: string;
  taskCommand: string;
  taskPort: number;
  firewallPorts: number[];
};

const HOST_DEFAULTS: DevHostState = {
  ramGB: 8,
  pageInitMB: 0,
  pageFileMaxMB: 0,
  diskFreeGB: 48,
  defenderExcluded: false,
  powerHighPerformance: false,
  taskName: "",
  taskState: "",
  taskTrigger: "",
  taskCommand: "",
  taskPort: 0,
  firewallPorts: [],
};

function readDevHostState(): DevHostState {
  const o = asRecord(readJson(HOST_FILE));
  const ports = Array.isArray(o.firewallPorts) ? o.firewallPorts.map((p) => num(p)).filter(isPort) : [];
  return {
    ramGB: num(o.ramGB, HOST_DEFAULTS.ramGB),
    pageInitMB: num(o.pageInitMB, HOST_DEFAULTS.pageInitMB),
    pageFileMaxMB: num(o.pageFileMaxMB, HOST_DEFAULTS.pageFileMaxMB),
    diskFreeGB: num(o.diskFreeGB, HOST_DEFAULTS.diskFreeGB),
    defenderExcluded: o.defenderExcluded === true,
    powerHighPerformance: o.powerHighPerformance === true,
    taskName: str(o.taskName, HOST_DEFAULTS.taskName),
    taskState: str(o.taskState, HOST_DEFAULTS.taskState),
    taskTrigger: str(o.taskTrigger, HOST_DEFAULTS.taskTrigger),
    taskCommand: str(o.taskCommand, HOST_DEFAULTS.taskCommand),
    taskPort: num(o.taskPort, HOST_DEFAULTS.taskPort),
    firewallPorts: [...new Set(ports)].toSorted((a, b) => a - b),
  };
}

/** 临时文件 + rename：和 state.ts 一样，宁可整份不写，也不留半个文件。 */
function writeDevHostState(next: DevHostState): void {
  mkdirSync(DEV_ROOT, { recursive: true });
  const tmp = `${HOST_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, HOST_FILE);
}

// ------------------------------------------------------------- 主机事实快照

/**
 * `collectHostFacts` 在开发模式下的早退点：返回同样形状的假事实，
 * 一行 PowerShell 都不跑（macOS 上也没有 PowerShell 可跑）。
 */
export function collectDevHostFacts(ports: number[]): HostFacts {
  const host = readDevHostState();
  const wanted = ports.filter(isPort);
  const snap = liveEngine();
  return {
    ramGB: host.ramGB,
    pageInitMB: host.pageInitMB,
    diskFreeGB: host.diskFreeGB,
    powerHighPerformance: host.powerHighPerformance,
    defenderExcluded: host.defenderExcluded,
    defenderDetail: host.defenderExcluded ? "已排除模拟根目录" : "未设置任何排除路径（模拟）",
    taskState: host.taskState,
    taskTrigger: host.taskTrigger,
    portInUse: snap !== null && wanted.includes(snap.port),
    firewallMissing: wanted.filter((p) => !host.firewallPorts.includes(p)),
  };
}

// --------------------------------------------------------------- setup / 自启

/** 和 commands.ts 的 taskCommandLine 同形：真实计划任务会执行的那条命令行。 */
function taskCommand(extraArgs: string[]): string {
  return selfCommand(["start", "--detach", ...extraArgs])
    .map((part) => (part.includes(" ") ? `"${part}"` : part))
    .join(" ");
}

/**
 * `setup` 的模拟版：把选中的项写进假 JSON，预演只打印不落盘。
 * 返回值语义和真实路径一致（0 = 成功），Main 直接拿它当命令退出码。
 */
export function setupDevHost(opts: SetupOptions, defaultPort: number): number {
  const ports = (opts.ports && opts.ports.length > 0 ? opts.ports : [defaultPort]).filter(isPort);
  const dryRun = opts.dryRun === true;
  const current = readDevHostState();
  const ram = current.ramGB;
  const init = opts.pageFileInitMB ?? (ram > 0 && ram <= 8 ? 8192 : 4096);
  const max = opts.pageFileMaxMB ?? (ram > 0 && ram <= 8 ? 16384 : 8192);
  const taskName = opts.taskName ?? DEFAULT_TASK;
  const next: DevHostState = { ...current, firewallPorts: [...current.firewallPorts] };

  header("Windows 主机配置（模拟）");
  console.log(dim(`  模拟根目录：${ROOT}`));
  console.log(dim(`  模拟状态文件：${HOST_FILE}`));
  console.log(dim(`  端口：${ports.join(", ")}${dryRun ? "（预演：不会真正修改）" : ""}`));

  if (opts.noFirewall) {
    console.log(dim("  跳过防火墙规则"));
  } else {
    for (const port of ports) {
      const name = `R5F dedi UDP ${port}`;
      if (next.firewallPorts.includes(port)) {
        console.log(dim(`  防火墙规则已存在：${name}（模拟）`));
      } else if (dryRun) {
        console.log(`  [预演] 将放行 UDP ${port}（规则名 ${name}）`);
      } else {
        next.firewallPorts.push(port);
        console.log(green(`  已放行 UDP ${port}（模拟）`));
      }
    }
  }

  if (opts.noPageFile) {
    console.log(dim("  跳过页面文件配置"));
  } else if (dryRun) {
    console.log(`  [预演] 物理内存 ${ram} GB，将把页面文件设为固定 ${init} MB（上限 ${max} MB）`);
  } else {
    next.pageInitMB = init;
    next.pageFileMaxMB = max;
    console.log(green(`  页面文件已设为固定 ${init} MB（物理内存 ${ram} GB，模拟）`));
  }
  if (ram > 0 && ram <= 8) {
    console.log(
      yellow("  提醒：8 GB 内存跑单实例（私有提交约 6.5 GB）会用到页面文件，换图时可能卡顿；加到 16 GB 更稳。"),
    );
  }

  const excludePaths = [ROOT, ...discoverVersions(ROOT, { withSizes: false }).map((v) => v.path)];
  if (opts.noDefender) {
    console.log(dim("  跳过 Defender 排除"));
  } else if (dryRun) {
    console.log(`  [预演] 将把以下路径加入 Defender 排除：${excludePaths.join(", ")}`);
  } else {
    next.defenderExcluded = true;
    console.log(green(`  已排除 ${excludePaths.length} 个路径 + r5apex_ds.exe（模拟）`));
  }

  const port = ports[0] ?? defaultPort;
  const commandLine = taskCommand([]);
  if (opts.noTask) {
    console.log(dim("  跳过计划任务"));
  } else if (dryRun) {
    console.log(`  [预演] 将创建计划任务「${taskName}」：登录时运行 ${commandLine}`);
  } else {
    next.taskName = taskName;
    next.taskState = "Ready";
    next.taskTrigger = "MSFT_TaskLogonTrigger";
    next.taskCommand = commandLine;
    next.taskPort = port;
    console.log(green(`  计划任务已创建：${taskName}（登录时启动，模拟）`));
  }

  if (opts.noPower) {
    console.log(dim("  跳过电源计划"));
  } else if (dryRun) {
    console.log("  [预演] 将把电源计划设为高性能");
  } else {
    next.powerHighPerformance = true;
    console.log(green("  电源计划：高性能（模拟）"));
  }

  if (dryRun) {
    console.log(dim("\n  预演结束：没有写任何文件，也没有碰任何系统设置。"));
  } else {
    next.firewallPorts.sort((a, b) => a - b);
    writeDevHostState(next);
    console.log(dim(`\n  已写入 ${HOST_FILE}（模拟主机状态，跨进程保留；没有碰任何系统设置）。`));
  }
  console.log(dim("  仅模拟配置反馈；不开放 UDP、不修改系统，也无需配置云防火墙。"));
  return 0;
}

/**
 * `autostart` 的模拟版：enable / disable / status 只读写假 JSON。
 *
 * `run` 明确不支持：真实路径靠 `schtasks /Run` 触发计划任务，这里既没有计划任务
 * 可触发，也不会顺手把引擎拉起来 —— 报「不支持」比假装已触发电好。
 */
export function autostartDevHost(opts: AutostartOptions, defaultPort: number): number {
  const taskName = opts.taskName ?? DEFAULT_TASK;
  const trigger = opts.trigger === "startup" ? "ONSTART" : "ONLOGON";
  const triggerClass = trigger === "ONSTART" ? "MSFT_TaskBootTrigger" : "MSFT_TaskLogonTrigger";
  const extra = opts.extraArgs ? opts.extraArgs.split(/\s+/).filter(Boolean) : [];
  const commandLine = taskCommand(extra);

  header(`开机自启（模拟）：${opts.action}`);

  if (opts.dryRun) {
    console.log(dim("  [预演] 不会修改系统，也不写模拟状态文件"));
    kv("任务名", taskName);
    kv("触发", trigger === "ONLOGON" ? "用户登录时" : "开机时");
    kv("命令", commandLine);
    kv("端口", String(defaultPort));
    kv("权限", "/RL HIGHEST（最高权限）");
    return 0;
  }

  if (opts.action === "run") {
    console.log(
      yellow(
        `  模拟主机不支持 run：真实路径用 schtasks /Run 触发计划任务「${taskName}」，本机没有计划任务，也不会启动任何进程。`,
      ),
    );
    return 1;
  }

  const host = readDevHostState();

  if (opts.action === "status") {
    if (host.taskState.length === 0 || host.taskName !== taskName) {
      console.log(yellow(`  计划任务「${taskName}」不存在（模拟）。`));
      console.log(dim("  开启：r5-server autostart enable"));
      return 1;
    }
    kv("任务名", host.taskName);
    kv("状态", host.taskState === "Ready" ? green("已就绪（等待触发）") : host.taskState);
    kv("端口", String(host.taskPort));
    kv("命令", host.taskCommand);
    console.log("");
    console.log(dim(`  以上来自模拟状态文件（${HOST_FILE}），没有查询真实计划任务。`));
    return 0;
  }

  if (opts.action === "disable") {
    if (host.taskState.length === 0 || host.taskName !== taskName) {
      console.log(yellow(`  计划任务「${taskName}」本来就没有（模拟）。`));
      return 0;
    }
    writeDevHostState({ ...host, taskName: "", taskState: "", taskTrigger: "", taskCommand: "", taskPort: 0 });
    console.log(green(`  已删除计划任务「${taskName}」（模拟）`));
    return 0;
  }

  // enable
  writeDevHostState({
    ...host,
    taskName,
    taskState: "Ready",
    taskTrigger: triggerClass,
    taskCommand: commandLine,
    taskPort: defaultPort,
  });
  console.log(green(`  已创建计划任务「${taskName}」（${trigger === "ONLOGON" ? "登录时" : "开机时"}启动，模拟）`));
  console.log(dim(`  命令：${commandLine}`));
  console.log(dim(`  已写入 ${HOST_FILE}（模拟主机状态，跨进程保留）。`));
  return 0;
}
