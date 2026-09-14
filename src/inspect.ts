/**
 * Read-only data collectors shared by the CLI commands and the TUI.
 *
 * Everything here is async: the TUI renders on a timer, and a synchronous
 * PowerShell call in that path makes keystrokes feel dead.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type ServerMetrics,
  currentVersion,
  describe,
  formatUptime,
  gameStateLabel,
  parseServerTitle,
  summariseLog,
} from "./serverinfo";
import { ROOT, type State } from "./state";
import { isPidAlive, stripAnsi } from "./tap";
import { asRecord, readTextIfPresent } from "./util";
import * as win from "./win";

export type Tone = "green" | "yellow" | "red" | "dim";
export type Row = { label: string; value: string; tone?: Tone };
export type Section = { title: string; rows: Row[] };

const POWER_HIGH_PERFORMANCE = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c";
const AUTOSTART_TASK = "R5F Dedicated Server";

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

// ------------------------------------------------------------------ sections

function liveInstanceRows(state: State, proc: win.ProcInfo, ports: string[]): Row[] {
  const metrics = parseServerTitle(proc.title);
  const rows: Row[] = [];
  rows.push({
    label: "进程",
    value: proc.startedAt ? `启动于 ${proc.startedAt}` : "运行中",
  });
  const uptime = formatUptime(state.runtime?.startedAt ?? "", proc.startedAt);
  if (uptime) rows.push({ label: "运行时长", value: uptime });
  if (metrics.players) rows.push({ label: "人数", value: metrics.players });
  if (metrics.map) rows.push({ label: "当前地图", value: metrics.map });
  if (metrics.cpuPercent) rows.push({ label: "服务端 CPU", value: `${metrics.cpuPercent}%` });
  if (metrics.frameMs) rows.push({ label: "帧耗时", value: `${metrics.frameMs} msec  帧号 ${metrics.frame ?? "-"}` });
  rows.push({
    label: "内存",
    value: `${proc.workingSetMB} MB 工作集 / ${proc.privateMB} MB 私有提交`,
  });
  rows.push({ label: "CPU 时间", value: `${Math.round(proc.cpuSeconds)} 秒` });
  rows.push({ label: "监听 UDP", value: ports.join(", ") || "(无)" });
  return rows;
}

function logRows(state: State, metrics: ServerMetrics): Row[] {
  const rows: Row[] = [];
  const logFile = state.runtime?.logFile;
  if (logFile && existsSync(logFile)) {
    const summary = summariseLog(logFile);
    if (!metrics.players) {
      const stateLabel = gameStateLabel(summary.gameState);
      if (stateLabel.length > 0) rows.push({ label: "游戏状态", value: stateLabel });
      if (summary.mapInit) rows.push({ label: "已加载地图", value: summary.mapInit });
    }
    const size = statSync(logFile).size;
    rows.push({
      label: "日志",
      value: `${Math.max(1, Math.round(size / 1024))} KB · 已写入到 ${summary.lastStamp ?? "?"} 秒`,
    });
  } else if (logFile) {
    rows.push({ label: "日志", value: "尚未生成" });
  } else {
    rows.push({ label: "日志", value: "未启用托管控制台", tone: "yellow" });
  }
  const daemon = state.runtime?.logdPid ?? 0;
  rows.push({
    label: "日志记录",
    value: isPidAlive(daemon) ? "运行中" : daemon ? "已停止（日志不再更新）" : "未启动",
    tone: isPidAlive(daemon) ? "green" : "yellow",
  });
  const ctlPort = state.runtime?.ctlPort ?? 0;
  rows.push({
    label: "远程管理",
    value:
      ctlPort > 0 && isPidAlive(daemon) ? "可用（查在线玩家 · 踢人 · 封禁 · 公告）" : "不可用（需要以托管方式启动）",
    tone: ctlPort > 0 && isPidAlive(daemon) ? "green" : "yellow",
  });
  return rows;
}

function hostRows(facts: HostFacts | null, state: State): Row[] {
  const port = state.settings.port;
  if (!facts) {
    return [{ label: "主机信息", value: "读取失败（PowerShell 不可用）", tone: "red" }];
  }
  const pf = facts.pageInitMB === -1 ? "系统托管" : facts.pageInitMB === 0 ? "未配置" : `${facts.pageInitMB} MB 固定`;
  const rows: Row[] = [
    { label: "物理内存", value: `${facts.ramGB} GB` },
    {
      label: "页面文件",
      value: pf,
      tone:
        facts.ramGB > 0 && facts.ramGB <= 8 && (facts.pageInitMB === -1 || facts.pageInitMB < 8192) ? "red" : undefined,
    },
    { label: "磁盘剩余", value: `${facts.diskFreeGB} GB` },
    {
      label: `UDP ${port}`,
      value: facts.portInUse ? "已被占用" : "空闲",
      tone: facts.portInUse ? "yellow" : "green",
    },
    {
      label: "防火墙规则",
      value:
        facts.firewallMissing.length === 0
          ? `已放行 ${port}`
          : `缺少放行（UDP ${facts.firewallMissing.join(", ")}）→ 在「主机配置」按回车应用`,
      tone: facts.firewallMissing.length === 0 ? "green" : "red",
    },
    {
      label: "Defender",
      value: facts.defenderExcluded ? "已排除根目录" : "未排除（可能导致服务端文件被误删）",
      tone: facts.defenderExcluded ? "green" : "yellow",
    },
    {
      label: "电源计划",
      value: facts.powerHighPerformance ? "高性能" : "非高性能（换图/加载会慢）",
      tone: facts.powerHighPerformance ? "green" : "yellow",
    },
    {
      label: "开机自启",
      value: facts.taskState.length === 0 ? "未配置" : `${facts.taskState}${triggerLabel(facts.taskTrigger)}`,
      tone: facts.taskState.length === 0 ? undefined : "green",
    },
  ];
  return rows;
}

export function triggerLabel(cimClass: string): string {
  if (cimClass.includes("Logon")) return "（登录时）";
  if (cimClass.includes("Boot")) return "（开机时）";
  return "";
}

/** 详情页：状态总览。 */
export async function collectDetail(state: State): Promise<Section[]> {
  const sections: Section[] = [];
  const version = currentVersion(state);
  const s = state.settings;
  sections.push({
    title: "版本与启动设置",
    rows: [
      {
        label: "当前版本",
        value: version ? `${version.name}  ${describe(version)}` : "未选择（主界面选中后回车）",
        tone: version ? "green" : "red",
      },
      {
        label: "启动设置",
        value: `UDP ${s.port} · 地图 ${s.map || "未指定"} · 模式 ${s.playlist || "未指定"} · 可见性 ${s.visibility === 0 ? "离线" : s.visibility === 1 ? "隐藏" : "公开"} · 认证 ${s.authMode === 0 ? "关闭" : s.authMode === 1 ? "强制校验" : "有就校验"}${s.password ? " · 有密码" : ""}`,
      },
      { label: "主机名", value: s.hostname || "(空)" },
      { label: "配额", value: `${s.quotaString} 条命令/秒 · ${s.quotaScript} 个脚本/秒` },
      { label: "附加参数", value: s.extra || "(空)" },
    ],
  });

  const procs = (await win.findDediProcessesAsync()).filter((p) => p.path.toLowerCase().startsWith(ROOT.toLowerCase()));
  if (procs.length === 0) {
    sections.push({ title: "实例", rows: [{ label: "进程", value: "未运行", tone: "dim" }] });
  } else {
    for (const proc of procs) {
      const ports = await win.udpEndpointsAsync(proc.pid);
      sections.push({ title: "实例", rows: liveInstanceRows(state, proc, ports) });
    }
  }

  const metrics = procs[0] ? parseServerTitle(procs[0].title) : {};
  sections.push({ title: "日志", rows: logRows(state, metrics) });

  const facts = await collectHostFacts([s.port]);
  sections.push({ title: "主机", rows: hostRows(facts, state) });

  const last = state.history.slice(0, 4);
  if (last.length > 0) {
    sections.push({
      title: "最近操作",
      rows: last.map((h) => ({
        label: h.action,
        value: `${h.at.replace("T", " ").replace(/\..*$/, "")}Z  ${h.detail}`,
        tone: "dim" as Tone,
      })),
    });
  }
  return sections;
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
      notes.push(`错误记录里有内容（${error.bytes} 字节）：本次运行出过问题，原文用 r5-server health 查看。`);
    } else {
      notes.push("错误记录是空的：本次运行没有出错。");
    }
    if (warning.bytes > 0) {
      notes.push("启动记录有内容：这是改版服务端启动自检的正常输出，不是故障。");
    }
    if (scriptWarning.bytes > 0) {
      notes.push("脚本侧有告警（不影响启动，需要时用 r5-server health 看原文）。");
    }
  }
  return { runId, runDir, latestOk, error, warning, scriptWarning, notes };
}

/** 体检页：和 collectDetail 同源，但只保留体检关心的项，并给出问题清单。 */
export async function collectDoctor(state: State): Promise<{ sections: Section[]; problems: string[] }> {
  const version = currentVersion(state);
  const facts = await collectHostFacts([state.settings.port]);
  const procs = (await win.findDediProcessesAsync()).filter((p) => p.path.toLowerCase().startsWith(ROOT.toLowerCase()));
  const problems: string[] = [];

  if (!version) problems.push("未选择版本（主界面选中版本后回车）");
  if (facts && facts.ramGB > 0 && facts.ramGB <= 8 && (facts.pageInitMB === -1 || facts.pageInitMB < 8192)) {
    problems.push("页面文件偏小（8 GB 机器建议固定 8192 MB 起）");
  }
  if (facts && facts.firewallMissing.length > 0) problems.push("缺少 Windows 防火墙规则（主机配置页可一键放行）");
  if (facts && !facts.defenderExcluded) problems.push("Defender 未排除根目录（可能导致服务端文件被误删）");
  if (facts && !facts.powerHighPerformance) problems.push("电源计划非高性能（加载/换图更慢）");
  if (facts && facts.diskFreeGB > 0 && facts.diskFreeGB < 30) problems.push("磁盘剩余不足 30 GB");
  if (facts && facts.taskState.length === 0) problems.push("未配置开机自启（主机配置页可开启）");

  const sections: Section[] = [
    {
      title: "版本",
      rows: [
        {
          label: "当前版本",
          value: version ? version.name : "未选择",
          tone: version ? "green" : "red",
        },
      ],
    },
    { title: "主机检查", rows: hostRows(facts, state) },
    {
      title: "实例",
      rows: [
        {
          label: "运行中",
          value: procs.length === 0 ? "无" : procs.map((p) => `占用 ${p.workingSetMB} MB`).join("、"),
        },
      ],
    },
  ];
  return { sections, problems };
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

/** Checklist wording; the port only shows up in the firewall rule name. */
const CAPABILITY_LABELS: Record<CapabilityId, (port: number) => string> = {
  firewall: (port) => `Windows 防火墙放行 UDP ${port}`,
  pagefile: () => "页面文件固定大小",
  defender: () => "Defender 排除服务器目录",
  task: () => "开机自启（登录时启动）",
  power: () => "电源计划设为高性能",
};

/** 主机配置页的清单：每项都来自真实探测，勾选状态即“当前是否已生效”。 */
export async function collectCapabilities(state: State): Promise<Capability[]> {
  const port = state.settings.port;
  const facts = await collectHostFacts([port]);
  if (!facts) {
    return CAPABILITY_ORDER.map((id) => ({
      id,
      label: CAPABILITY_LABELS[id](port),
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
  return [
    {
      id: "firewall",
      label: CAPABILITY_LABELS.firewall(port),
      enabled: facts.firewallMissing.length === 0,
      detail: facts.firewallMissing.length === 0 ? `已放行 UDP ${port}` : `未放行 UDP ${port}`,
    },
    {
      id: "pagefile",
      label: CAPABILITY_LABELS.pagefile(port),
      enabled: facts.pageInitMB > 0,
      detail: `${pfDetail}（8 GB 内存建议 8192/16384）`,
    },
    {
      id: "defender",
      label: CAPABILITY_LABELS.defender(port),
      enabled: facts.defenderExcluded,
      detail: facts.defenderExcluded ? "已排除安装根目录" : facts.defenderDetail,
    },
    {
      id: "task",
      label: CAPABILITY_LABELS.task(port),
      enabled: facts.taskState.length > 0,
      detail: facts.taskState.length > 0 ? `已配置${triggerLabel(facts.taskTrigger)}` : "未配置",
    },
    {
      id: "power",
      label: CAPABILITY_LABELS.power(port),
      enabled: facts.powerHighPerformance,
      detail: facts.powerHighPerformance ? "已是高性能" : "当前非高性能",
    },
  ];
}
