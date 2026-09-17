/**
 * Read-only data collectors shared by the panel.
 *
 * Everything here is async: the panel refreshes on a timer, and a synchronous
 * PowerShell call in that path stalls the render loop.
 *
 * 开发模式（R5F_DEV=1）下主机来源换成本机假数据（`dev-host.ts`）；页面上凡是由
 * 假数据得出的地方都带「模拟」字样 —— 面板宁可说得啰嗦，也不让人把模拟数据当真。
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEV_MODE } from "./dev";
import { collectDevHostFacts } from "./dev-host";
import { portFamily } from "./instances";
import { currentVersion } from "./serverinfo";
import { ROOT, type Runtime, type ServerInstance, type State, defaultSettings, selectedInstance } from "./state";
import { isPidAlive, stripAnsi } from "./tap";
import { asRecord, readTextIfPresent } from "./util";
import * as win from "./win";
const POWER_HIGH_PERFORMANCE = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c";
const AUTOSTART_TASK = "R5F Dedicated Server";

/** 端口：选中实例的设置端口；没有实例时用默认设置（体检/主机页要一个可说的数）。 */
function portOf(instance: ServerInstance | null): number {
  return instance?.settings.port ?? defaultSettings.port;
}

/**
 * 一个实例占用的整组 UDP 端口（游戏 / S2S / 客户端）。
 * 防火墙与"端口是否被占"都按整组算 —— 只放游戏端口的话，上架探测就通不过。
 */
function portsOf(instance: ServerInstance | null): number[] {
  return portFamily(portOf(instance));
}

/**
 * 日志写入方是否还活着。
 *
 * 真实模式是独立的日志守护（`runtime.logdPid`）；开发模式的模拟引擎**自己**就是
 * 日志守护 —— 启动时不给 `logdPid` 赋值（否则停止路径会把它当第二个进程再杀一次），
 * 所以这里退回实例 pid。写不进去的日志比"守护状态"更值得说清楚，故单独成函数。
 */
export function logSinkAlive(runtime: Runtime | null): boolean {
  if (!runtime) return false;
  if (runtime.logdPid !== undefined) return isPidAlive(runtime.logdPid);
  return DEV_MODE && isPidAlive(runtime.pid);
}

// --------------------------------------------------------------- json guards

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function strList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

// ------------------------------------------------------------- host snapshot

export type HostFacts = {
  ramGB: number;
  pageInitMB: number;
  diskFreeGB: number;
  powerHighPerformance: boolean;
  defenderExcluded: boolean;
  defenderDetail: string;
  taskState: string;
  taskTrigger: string;
  portInUse: boolean;
  firewallMissing: number[];
};

/**
 * One PowerShell round trip for everything the detail/doctor/config pages need
 * from the host. Returns null when the shell could not be reached.
 */
export async function collectHostFacts(ports: number[]): Promise<HostFacts | null> {
  // 开发模式早退：macOS 上没有 PowerShell/CIM，主机信息全部来自假状态文件。
  if (DEV_MODE) return collectDevHostFacts(ports);
  const portList = ports.filter((p) => Number.isFinite(p) && p > 0);
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$cs = Get-CimInstance Win32_ComputerSystem",
    "$pf = Get-CimInstance Win32_PageFileSetting | Select-Object -First 1",
    `$root = ${win.psQuote(ROOT)}`,
    `$ports = @(${portList.join(",")})`,
    "$ex = @((Get-MpPreference).ExclusionPath)",
    `$task = Get-ScheduledTask -TaskName ${win.psQuote(AUTOSTART_TASK)}`,
    "$scheme = (powercfg.exe /getactivescheme) -join ' '",
    "$rules = @(Get-NetFirewallRule | Where-Object { $_.DisplayName -like 'R5F dedi UDP *' } | ForEach-Object { $_.DisplayName })",
    "$busy = @()",
    "$missing = @()",
    "foreach ($p in $ports) {",
    "  if (Get-NetUDPEndpoint -LocalPort $p) { $busy += $p }",
    '  if (-not ($rules -contains "R5F dedi UDP $p")) { $missing += $p }',
    "}",
    "$o = [ordered]@{",
    "  ramGB = [math]::Round($cs.TotalPhysicalMemory / 1GB)",
    "  pageInitMB = if ($pf) { [int]$pf.InitialSize } elseif ($cs.AutomaticManagedPagefile) { -1 } else { 0 }",
    "  diskFreeGB = [math]::Round((Get-PSDrive -Name ((Get-Item -LiteralPath $root).PSDrive.Name)).Free / 1GB)",
    "  scheme = $scheme",
    "  defender = $ex",
    "  root = $root",
    "  task = if ($task) { [string]$task.State } else { '' }",
    "  trigger = if ($task) { [string]$task.Triggers[0].CimClass.CimClassName } else { '' }",
    "  busyPorts = $busy",
    "  missingPorts = $missing",
    "}",
    "$o | ConvertTo-Json -Compress -Depth 4",
  ].join("\n");
  const res = await win.psAsync(script);
  const json = res.out.split(/\r?\n/).findLast((line) => line.trim().startsWith("{"));
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const o = asRecord(parsed);
  const defender = strList(o.defender);
  const root = str(o.root, ROOT);
  const scheme = str(o.scheme);
  return {
    ramGB: num(o.ramGB),
    pageInitMB: num(o.pageInitMB),
    diskFreeGB: num(o.diskFreeGB),
    powerHighPerformance: scheme.toLowerCase().includes(POWER_HIGH_PERFORMANCE),
    defenderExcluded: defender.some((p) => p.toLowerCase() === root.toLowerCase()),
    defenderDetail: defender.length === 0 ? "未设置任何排除路径" : `${defender.length} 条排除路径`,
    taskState: str(o.task),
    taskTrigger: str(o.trigger),
    portInUse: Array.isArray(o.busyPorts) ? o.busyPorts.length > 0 : false,
    firewallMissing: Array.isArray(o.missingPorts) ? o.missingPorts.map((p) => num(p)).filter((p) => p > 0) : [],
  };
}

export function triggerLabel(cimClass: string): string {
  if (cimClass.includes("Logon")) return "（登录时）";
  if (cimClass.includes("Boot")) return "（开机时）";
  return "";
}

// ------------------------------------------------------- current run health

export type HealthFile = {
  path: string;
  exists: boolean;
  bytes: number;
  mtime: number;
  lines: string[];
};

export type Health = {
  runId: string;
  runDir: string;
  latestOk: boolean;
  error: HealthFile;
  warning: HealthFile;
  scriptWarning: HealthFile;
  notes: string[];
};

/** 每个文件最多读尾部 64 KB / 200 行：`error.log` 非空即问题，不需要全文。 */
function readHealthFile(path: string): HealthFile {
  if (path.length === 0 || !existsSync(path)) {
    return { path, exists: false, bytes: 0, mtime: 0, lines: [] };
  }
  const stats = statSync(path);
  const window = Math.min(stats.size, 64 * 1024);
  const fd = openSync(path, "r");
  let text = "";
  try {
    const buffer = Buffer.alloc(window);
    readSync(fd, buffer, 0, window, stats.size - window);
    text = buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => stripAnsi(line))
    .filter((line) => line.trim().length > 0)
    .slice(-200);
  return { path, exists: true, bytes: stats.size, mtime: stats.mtimeMs, lines };
}

/**
 * 本次运行的健康：`platform/logs/server/latest.txt` 里是本次运行的 uuid 目录名，
 * 该目录下是引擎自己写的 `error.log` / `warning.log` / `script_warning.log`。
 *
 * 判级别只看**文件与词**，绝不看 `Native(E)/(F)` 前缀 —— 实测 `Native(E)` 里是
 * `State_NewGame: Loading level`、`Installed NetKey` 这类正常行，前缀不代表级别。
 */
export async function collectHealth(state: State): Promise<Health> {
  const version = currentVersion(state);
  const logRoot = version ? join(version.path, "platform", "logs", "server") : "";
  const latestPath = logRoot.length > 0 ? join(logRoot, "latest.txt") : "";
  const runId =
    latestPath.length > 0 && existsSync(latestPath)
      ? readTextIfPresent(latestPath).trim().split(/\r?\n/)[0].trim()
      : "";
  const runDir = runId.length > 0 ? join(logRoot, runId) : "";
  const latestOk = runDir.length > 0 && existsSync(runDir);
  const error = readHealthFile(runDir.length > 0 ? join(runDir, "error.log") : "");
  const warning = readHealthFile(runDir.length > 0 ? join(runDir, "warning.log") : "");
  const scriptWarning = readHealthFile(runDir.length > 0 ? join(runDir, "script_warning.log") : "");

  const notes: string[] = [];
  if (!version) {
    notes.push("还没有选择版本，读不到运行记录。");
  } else if (latestPath.length === 0 || !existsSync(latestPath)) {
    notes.push("还没有运行记录（这个实例从没启动过？）。");
  } else if (runId.length === 0) {
    notes.push("读不到本次运行的记录目录。");
  } else if (!latestOk) {
    notes.push(`latest.txt 指向的目录不存在：${runDir}`);
  }
  if (latestOk) {
    if (error.bytes > 0) {
      notes.push(`错误记录里有内容（${error.bytes} 字节）：本次运行出过问题，原文在「体检」页可以看到。`);
    } else {
      notes.push("错误记录是空的：本次运行没有出错。");
    }
    if (warning.bytes > 0) {
      notes.push("启动记录有内容：这是改版服务端启动自检的正常输出，不是故障。");
    }
    if (scriptWarning.bytes > 0) {
      notes.push("脚本侧有告警（不影响启动，需要时在「体检」页看原文）。");
    }
  }
  return { runId, runDir, latestOk, error, warning, scriptWarning, notes };
}

// --------------------------------------------------------------- capabilities

export type CapabilityId = "firewall" | "pagefile" | "defender" | "task" | "power";

export type Capability = {
  id: CapabilityId;
  label: string;
  enabled: boolean;
  detail: string;
};

/** Checklist order; the router walks the returned array in this order. */
const CAPABILITY_ORDER: CapabilityId[] = ["firewall", "pagefile", "defender", "task", "power"];

/** Checklist wording. Panel-only: values (port, MB, rule names) live in `detail`. */
const CAPABILITY_LABELS: Record<CapabilityId, string> = {
  firewall: "放行游戏端口",
  pagefile: "固定页面文件大小",
  defender: "排除杀毒软件扫描目录",
  task: "开机自启",
  power: "高性能电源计划",
};

/** 主机配置页的清单：每项都来自真实探测（开发模式下来自模拟状态文件），勾选状态即“当前是否已生效”。 */
export async function collectCapabilities(state: State): Promise<Capability[]> {
  const instance = selectedInstance(state);
  const port = portOf(instance);
  const facts = await collectHostFacts(portsOf(instance));
  if (!facts) {
    return CAPABILITY_ORDER.map((id) => ({
      id,
      label: CAPABILITY_LABELS[id],
      enabled: false,
      detail: "探测失败",
    }));
  }
  const pfDetail =
    facts.pageInitMB === -1
      ? "当前：系统托管"
      : facts.pageInitMB === 0
        ? "当前：未配置"
        : `当前：固定 ${facts.pageInitMB} MB`;
  const caps: Capability[] = [
    {
      id: "firewall",
      label: CAPABILITY_LABELS.firewall,
      enabled: facts.firewallMissing.length === 0,
      detail: facts.firewallMissing.length === 0 ? `已放行 UDP ${port}` : `未放行 UDP ${port}`,
    },
    {
      id: "pagefile",
      label: CAPABILITY_LABELS.pagefile,
      enabled: facts.pageInitMB > 0,
      detail: `${pfDetail}（8 GB 内存建议 8192/16384）`,
    },
    {
      id: "defender",
      label: CAPABILITY_LABELS.defender,
      enabled: facts.defenderExcluded,
      detail: facts.defenderExcluded ? "已排除安装根目录" : facts.defenderDetail,
    },
    {
      id: "task",
      label: CAPABILITY_LABELS.task,
      enabled: facts.taskState.length > 0,
      detail: facts.taskState.length > 0 ? `已配置${triggerLabel(facts.taskTrigger)}` : "未配置",
    },
    {
      id: "power",
      label: CAPABILITY_LABELS.power,
      enabled: facts.powerHighPerformance,
      detail: facts.powerHighPerformance ? "已是高性能" : "当前非高性能",
    },
  ];
  // 开发模式下清单照旧，只是数据来自假状态文件：在标签上标明，别让人当成真探测。
  return DEV_MODE ? caps.map((cap) => ({ ...cap, label: `${cap.label}（模拟）` })) : caps;
}
