/**
 * Windows helpers: console setup (UTF-8 + ANSI via FFI), admin detection,
 * UAC self-elevation, PowerShell execution, process queries.
 */
import { dlopen, FFIType } from "bun:ffi";

const STD_OUTPUT_HANDLE = -11;
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;

let consoleReady = false;

/** Switch the console to UTF-8 and enable ANSI escape handling. Best effort. */
export function initConsole(): void {
  if (consoleReady) return;
  consoleReady = true;
  try {
    const k32 = dlopen("kernel32.dll", {
      SetConsoleOutputCP: { args: [FFIType.u32], returns: FFIType.i32 },
      SetConsoleCP: { args: [FFIType.u32], returns: FFIType.i32 },
      GetStdHandle: { args: [FFIType.i32], returns: FFIType.i64 },
      GetConsoleMode: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
      SetConsoleMode: { args: [FFIType.i64, FFIType.u32], returns: FFIType.i32 },
    });
    k32.symbols.SetConsoleOutputCP(65001);
    k32.symbols.SetConsoleCP(65001);
    const handle = k32.symbols.GetStdHandle(STD_OUTPUT_HANDLE);
    const mode = new Uint32Array(1);
    if (k32.symbols.GetConsoleMode(handle, mode)) {
      k32.symbols.SetConsoleMode(handle, mode[0] | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
    }
  } catch {
    /* not an interactive Windows console: keep going */
  }
}

function run(cmd: string[], opts: { cwd?: string } = {}) {
  const p = Bun.spawnSync({ cmd, cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return {
    code: p.exitCode ?? -1,
    out: p.stdout.toString().trim(),
    err: p.stderr.toString().trim(),
  };
}

/**
 * PowerShell invocation with the script encoded (UTF-16LE base64), so quoting
 * is safe. `interactive` keeps PowerShell's own prompts enabled: elevation
 * needs it for the UAC consent dialog.
 */
function psCommand(script: string, interactive = false): string[] {
  const args = ["powershell", "-NoProfile"];
  if (!interactive) args.push("-NonInteractive");
  args.push("-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"));
  return args;
}

/** Run a PowerShell script body supplied inline. */
export function ps(script: string, opts: { cwd?: string } = {}) {
  return run(psCommand(script), opts);
}

/**
 * Non-blocking variants. The TUI polls process/port state on a timer; using the
 * sync helpers there would stall the event loop and make keystrokes feel dead.
 */
async function runAsync(cmd: string[], opts: { cwd?: string } = {}) {
  const p = Bun.spawn({ cmd, cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  return { code: p.exitCode ?? -1, out: out.trim(), err: err.trim() };
}

export async function psAsync(script: string, opts: { cwd?: string } = {}) {
  return runAsync(psCommand(script), opts);
}

/** Single-quote a value for embedding in a PowerShell script. */
export function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

export function isAdmin(): boolean {
  const r = ps(
    "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
  );
  return r.out.trim().toLowerCase() === "true";
}

/**
 * Re-launch this executable elevated and wait for it, so the operator sees the
 * result in the same window. Returns the child exit code, or null when UAC was
 * declined (the shell reports 1223 = ERROR_CANCELLED).
 */
export async function elevateSelf(args: string[]): Promise<number | null> {
  const script = [
    "$ErrorActionPreference='Stop'",
    "try {",
    `  $p = Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList @(${args.map(psQuote).join(",")}) -Verb RunAs -PassThru -Wait`,
    "  exit $p.ExitCode",
    "} catch { exit 1223 }",
  ].join("\n");
  const child = Bun.spawn({
    cmd: psCommand(script, true),
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const code = await child.exited;
  return code === 1223 ? null : code;
}

export type ProcInfo = {
  pid: number;
  workingSetMB: number;
  privateMB: number;
  cpuSeconds: number;
  title: string;
  path: string;
  startedAt: string;
};

const toNumber = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const asText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** ".NET TimeSpan" JSON: ISO-8601 (PS7), a {Ticks} object (PS5), or raw ticks. */
function timeSpanToSeconds(value: unknown): number {
  if (typeof value === "string") {
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(value);
    if (!m) return 0;
    return toNumber(m[1]) * 3600 + toNumber(m[2]) * 60 + Number(m[3] ?? 0);
  }
  if (typeof value === "object" && value !== null) {
    const ticks = toNumber((value as Record<string, unknown>).Ticks);
    return ticks > 0 ? Math.round(ticks / 1e7) : 0;
  }
  const ticks = toNumber(value);
  return ticks > 0 ? Math.round(ticks / 1e7) : 0;
}

function toProcInfo(raw: unknown): ProcInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const pid = toNumber(o.Id);
  if (!pid) return null;
  return {
    pid,
    workingSetMB: Math.round(toNumber(o.WorkingSet64) / 1048576),
    privateMB: Math.round(toNumber(o.PrivateMemorySize64) / 1048576),
    cpuSeconds: timeSpanToSeconds(o.TotalProcessorTime),
    title: asText(o.MainWindowTitle),
    path: asText(o.Path),
    startedAt: asText(o.StartTime),
  };
}

const PROC_SELECT =
  "Select-Object Id,WorkingSet64,PrivateMemorySize64,TotalProcessorTime,MainWindowTitle,Path,StartTime";

/** Shared by the sync and async callers so both query the same fields. */
function processQuery(filter: string): string {
  return `Get-Process ${filter} -ErrorAction SilentlyContinue | ${PROC_SELECT} | ConvertTo-Json -Compress`;
}

function parseProcJson(out: string): ProcInfo[] {
  if (!out) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map(toProcInfo).filter((p): p is ProcInfo => p !== null);
}

export function getProcess(pid: number): ProcInfo | null {
  return parseProcJson(ps(processQuery(`-Id ${pid}`)).out)[0] ?? null;
}

/** 同一份查询的非阻塞版本：面板按秒轮询，绝不能在渲染循环里跑 spawnSync。 */
export async function getProcessAsync(pid: number): Promise<ProcInfo | null> {
  return parseProcJson((await psAsync(processQuery(`-Id ${pid}`))).out)[0] ?? null;
}

export function findDediProcesses(name = "r5apex_ds"): ProcInfo[] {
  return parseProcJson(ps(processQuery(`-Name ${name}`)).out);
}

export async function findDediProcessesAsync(name = "r5apex_ds"): Promise<ProcInfo[]> {
  return parseProcJson((await psAsync(processQuery(`-Name ${name}`))).out);
}

export function killTree(pid: number): boolean {
  return run(["taskkill", "/PID", String(pid), "/T", "/F"]).code === 0;
}

/**
 * One query, two spawn modes: the CLI runs it synchronously, the dashboard
 * asynchronously so a slow PowerShell call cannot stall the render loop.
 */
function udpEndpointsQuery(pid: number): string {
  return `Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq ${pid} } | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" }`;
}

export function udpEndpoints(pid: number): string[] {
  const r = ps(udpEndpointsQuery(pid));
  return r.out ? r.out.split(/\r?\n/).filter(Boolean) : [];
}

export async function udpEndpointsAsync(pid: number): Promise<string[]> {
  const r = await psAsync(udpEndpointsQuery(pid));
  return r.out ? r.out.split(/\r?\n/).filter(Boolean) : [];
}

export function portInUse(port: number): boolean {
  return (
    ps(
      `if (Get-NetUDPEndpoint -LocalPort ${port} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`,
    ).out.trim() === "yes"
  );
}

export function physicalRamGB(): number {
  return toNumber(ps("[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)").out);
}

export function firewallRuleExists(displayName: string): boolean {
  return (
    ps(
      `if (Get-NetFirewallRule -DisplayName ${psQuote(displayName)} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`,
    ).out.trim() === "yes"
  );
}
