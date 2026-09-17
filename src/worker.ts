/**
 * 内部 worker：宿主之外**唯一**取参数的地方（没有面向用户的命令行）。
 *
 * 必须在独立进程里跑的活都通过 `workerCommand()` 重新进入 `src/worker-entry.ts`，
 * argv 形如 `<操作> [参数...]`：`setup` / `autostart`（提权改系统设置）、`start`
 * （计划任务触发的启动，总是后台）、`__logd`（日志守护，常驻）、`__dev-engine` /
 * `__dev-stop`（开发模拟）。参数形状沿用旧的公开命令 —— 计划任务里钉的就是这串参数，
 * 变的只有宿主前缀。
 *
 * parseArgs 用严格模式：内部调用写错参数要**当场报错** —— `setup` 会真改系统设置。
 */
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import {
  type AutostartOptions,
  type SetupOptions,
  type StartOptions,
  cmdAutostart,
  cmdSetup,
  cmdStart,
} from "./commands";
import { DEV_MODE } from "./dev";
import { type DevEngineOptions, runDevEngine } from "./dev-engine";
import { requestDevStop } from "./dev-protocol";
import { type Settings, loadState } from "./state";
import { type LogDaemonOptions, WORKER_OPS, runLogDaemon } from "./tap";

/** 参数写错：入口把消息印到 stderr 并以 1 退出。 */
export class WorkerUsageError extends Error {}

/** 已知操作（拼错时列出来，省得去翻代码）。 */
const OPERATIONS = [
  WORKER_OPS.setup,
  WORKER_OPS.autostart,
  WORKER_OPS.start,
  WORKER_OPS.logDaemon,
  WORKER_OPS.devEngine,
  WORKER_OPS.devStop,
];

/**
 * 跑一条 worker 操作，返回它自己的退出码（0 = 成功）。
 * 长驻操作（`__logd` / `__dev-engine`）在这里一直等着，直到它们自己返回。
 */
export async function runWorker(args: string[]): Promise<number> {
  const [operation, ...rest] = args;
  switch (operation) {
    case WORKER_OPS.setup:
      return await runSetup(rest);
    case WORKER_OPS.autostart:
      return await runAutostart(rest);
    case WORKER_OPS.start:
      return await runStart(rest);
    case WORKER_OPS.logDaemon:
      return await runLogDaemonOp(rest);
    case WORKER_OPS.devEngine:
      return await runDevEngineOp(rest);
    case WORKER_OPS.devStop:
      return await runDevStop(rest);
    default:
      throw new WorkerUsageError(`未知的内部操作「${operation ?? ""}」（可用：${OPERATIONS.join(" ")}）`);
  }
}

/** `--ports` 可以重复、也可以逗号分隔；只留下合法的 UDP 端口。 */
function parsePorts(raw: string[] | undefined): number[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .flatMap((part) => part.split(","))
    .map((part) => Number(part.trim()))
    .filter((port) => Number.isFinite(port) && port > 0 && port <= 65535);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new WorkerUsageError(`${flag} 需要数字，收到「${describeValue(value)}」`);
  return parsed;
}

/** 报错里的取值：字符串原样，其余走 JSON 序列化（对象不会被印成 `[object Object]`）。 */
function describeValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "（不可序列化的取值）");
}

/** `--visibility` 与 `--auth` 都是 0/1/2 三档。 */
function levelOrUndefined(value: unknown, flag: string): 0 | 1 | 2 | undefined {
  const level = numberOrUndefined(value, flag);
  if (level === undefined) return undefined;
  if (!Number.isInteger(level) || level < 0 || level > 2) throw new WorkerUsageError(`${flag} 只能是 0 / 1 / 2`);
  return level as 0 | 1 | 2;
}

/** 严格解析：未知参数抛出 WorkerUsageError（带上是谁的参数出错）。 */
function parseOptions(
  operation: string,
  args: string[],
  options: ParseArgsOptionsConfig,
  allowPositionals = false,
): { values: Record<string, unknown>; positionals: string[] } {
  try {
    const parsed = parseArgs({ args, options, strict: true, allowPositionals });
    return { values: parsed.values, positionals: parsed.positionals };
  } catch (err) {
    throw new WorkerUsageError(`${operation}：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 必填项缺失：一次把所有缺的列出来，别让人试一次改一个。 */
function requireStrings(operation: string, values: Record<string, unknown>, flags: string[]): string[] {
  const missing = flags.filter((flag) => typeof values[flag] !== "string");
  if (missing.length > 0) {
    throw new WorkerUsageError(`${operation}：缺少 ${missing.map((flag) => `--${flag}`).join(" ")}`);
  }
  return flags.map((flag) => values[flag] as string);
}

async function runSetup(args: string[]): Promise<number> {
  const { values } = parseOptions(WORKER_OPS.setup, args, {
    ports: { type: "string", multiple: true },
    "dry-run": { type: "boolean" },
    "no-task": { type: "boolean" },
    "no-firewall": { type: "boolean" },
    "no-power": { type: "boolean" },
    "no-defender": { type: "boolean" },
    "no-pagefile": { type: "boolean" },
    "task-name": { type: "string" },
    "page-init": { type: "string" },
    "page-max": { type: "string" },
  });
  const opts: SetupOptions = {
    ports: parsePorts(values.ports as string[] | undefined),
    dryRun: values["dry-run"] === true,
    noTask: values["no-task"] === true,
    noFirewall: values["no-firewall"] === true,
    noPower: values["no-power"] === true,
    noDefender: values["no-defender"] === true,
    noPageFile: values["no-pagefile"] === true,
    taskName: stringOrUndefined(values["task-name"]),
    pageFileInitMB: numberOrUndefined(values["page-init"], "--page-init"),
    pageFileMaxMB: numberOrUndefined(values["page-max"], "--page-max"),
  };
  // rawArgs 原样回传：提权后要用**同一串**参数再进来一次，`--dry-run` 之类的语义不能丢。
  return await cmdSetup(loadState(), opts, args);
}

async function runAutostart(args: string[]): Promise<number> {
  const { values, positionals } = parseOptions(
    WORKER_OPS.autostart,
    args,
    {
      trigger: { type: "string" },
      "task-name": { type: "string" },
      args: { type: "string" },
      "dry-run": { type: "boolean" },
    },
    true,
  );
  const action = positionals[0] ?? "status";
  if (action !== "enable" && action !== "disable" && action !== "status" && action !== "run") {
    throw new WorkerUsageError(`${WORKER_OPS.autostart}：不认识的动作「${action}」`);
  }
  const trigger = values.trigger;
  if (trigger !== undefined && trigger !== "logon" && trigger !== "startup") {
    throw new WorkerUsageError(`${WORKER_OPS.autostart}：--trigger 只能是 logon / startup`);
  }
  const opts: AutostartOptions = {
    action,
    taskName: stringOrUndefined(values["task-name"]),
    trigger,
    extraArgs: stringOrUndefined(values.args),
    dryRun: values["dry-run"] === true,
  };
  return await cmdAutostart(loadState(), opts, args);
}

/**
 * 计划任务/自启触发的启动。**总是后台**：worker 里没有可接管的终端，
 * 所以这里没有前台开关，也没有给旧命令行留兼容参数。
 */
async function runStart(args: string[]): Promise<number> {
  const { values } = parseOptions(WORKER_OPS.start, args, {
    instance: { type: "string" },
    port: { type: "string" },
    map: { type: "string" },
    playlist: { type: "string" },
    visibility: { type: "string" },
    auth: { type: "string" },
    password: { type: "string" },
    hostname: { type: "string" },
    force: { type: "boolean" },
    "no-host": { type: "boolean" },
  });
  const opts: StartOptions = {
    instance: stringOrUndefined(values.instance),
    port: numberOrUndefined(values.port, "--port"),
    map: stringOrUndefined(values.map),
    playlist: stringOrUndefined(values.playlist),
    visibility: levelOrUndefined(values.visibility, "--visibility"),
    auth: levelOrUndefined(values.auth, "--auth"),
    password: stringOrUndefined(values.password),
    hostname: stringOrUndefined(values.hostname),
    force: values.force === true,
    hosted: values["no-host"] !== true,
  };
  return await cmdStart(loadState(), opts);
}

async function runLogDaemonOp(args: string[]): Promise<number> {
  const { values } = parseOptions(WORKER_OPS.logDaemon, args, {
    "out-pipe": { type: "string" },
    "in-pipe": { type: "string" },
    log: { type: "string" },
    "pid-file": { type: "string" },
    "ctl-port": { type: "string" },
    "ctl-token": { type: "string" },
    root: { type: "string" },
  });
  const [outPipe, inPipe, logFile, pidFile] = requireStrings(WORKER_OPS.logDaemon, values, [
    "out-pipe",
    "in-pipe",
    "log",
    "pid-file",
  ]);
  const opts: LogDaemonOptions = {
    outPipe,
    inPipe,
    logFile,
    pidFile,
    // ctl-port 0 = 由系统分配：守护把真实端口印在 stdout 的 `READY <port>` 上。
    ctlPort: Number.parseInt(stringOrUndefined(values["ctl-port"]) ?? "0", 10) || 0,
    ctlToken: stringOrUndefined(values["ctl-token"]) ?? "",
    root: stringOrUndefined(values.root),
  };
  return await runLogDaemon(opts);
}

async function runDevEngineOp(args: string[]): Promise<number> {
  if (!DEV_MODE) throw new Error("模拟引擎只在 R5F_DEV=1 时可用。");
  const { values } = parseOptions(WORKER_OPS.devEngine, args, {
    instance: { type: "string" },
    "version-path": { type: "string" },
    settings: { type: "string" },
    log: { type: "string" },
    "ctl-token": { type: "string" },
  });
  const [instance, versionPath, settings, logFile, ctlToken] = requireStrings(WORKER_OPS.devEngine, values, [
    "instance",
    "version-path",
    "settings",
    "log",
    "ctl-token",
  ]);
  const opts: DevEngineOptions = {
    instance,
    versionPath,
    settings: JSON.parse(settings) as Settings,
    logFile,
    ctlToken,
  };
  return await runDevEngine(opts);
}

async function runDevStop(args: string[]): Promise<number> {
  if (!DEV_MODE) throw new Error("模拟引擎只在 R5F_DEV=1 时可用。");
  const pid = Number(args[0]);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new WorkerUsageError(`${WORKER_OPS.devStop}：需要一个正整数进程号，收到「${args[0] ?? ""}」`);
  }
  return (await requestDevStop(pid)) ? 0 : 1;
}
