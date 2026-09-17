import { randomUUID } from "node:crypto";
/**
 * Hosted console tap + 内部 worker 的重新进入契约。
 *
 * server.dll honours four environment variables when it starts:
 *   R5F_HOSTED_CONSOLE=1
 *   R5F_CONSOLE_PIPE=\\.\pipe\<name>   engine -> us (console output)
 *   R5F_CONSOLE_IN=\\.\pipe\<name>     us -> engine (console input)
 *   R5F_CONSOLE_ROLE=s                 dedicated server role
 *
 * The engine writes its console output into that pipe instead of only into its
 * own console window, which is what makes real log streaming possible.
 *
 * The pipe owner has to outlive the panel (output must keep flowing after the
 * operator closes the window), so it runs as a detached worker child (`__logd`)
 * that appends every line to a log file; the log page tails that file.
 */
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, statSync, closeSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { type ModerationEntry, dueEntries, loadModeration, markUnbanned } from "./moderation";

export const HOSTED_ENV = "R5F_HOSTED_CONSOLE";
export const PIPE_ENV = "R5F_CONSOLE_PIPE";
export const IN_ENV = "R5F_CONSOLE_IN";
export const ROLE_ENV = "R5F_CONSOLE_ROLE";

export type TapNames = { id: string; outPipe: string; inPipe: string };

export function makeTapNames(): TapNames {
  const id = randomUUID().replace(/-/g, "");
  return {
    id,
    outPipe: `\\\\.\\pipe\\r5f-con-s-${id}`,
    inPipe: `\\\\.\\pipe\\r5f-in-s-${id}`,
  };
}

export function hostedEnv(names: TapNames): Record<string, string> {
  return {
    [HOSTED_ENV]: "1",
    [PIPE_ENV]: names.outPipe,
    [IN_ENV]: names.inPipe,
    [ROLE_ENV]: "s",
  };
}

export function logDir(root: string): string {
  const dir = join(root, "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function logFileFor(root: string, version: string, port: number): string {
  return join(logDir(root), `${version}-${port}.log`);
}

export type LogDaemonOptions = {
  outPipe: string;
  inPipe: string;
  logFile: string;
  pidFile: string;
  /** loopback control port for console commands; omit to disable, 0 = ephemeral */
  ctlPort?: number;
  /** shared secret the control client must send first */
  ctlToken?: string;
  /** 工具根目录：到期临时封禁的解封要读写这里的 `moderation.json` */
  root?: string;
};

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });
/** CP936 consoles emit GBK; decoding it as UTF-8 would mangle Chinese output. */
const GBK = new TextDecoder("gbk");

/** Decode one line of console bytes: UTF-8 when valid, otherwise GBK. */
function decodeLine(bytes: Buffer): string {
  try {
    return UTF8_STRICT.decode(bytes);
  } catch {
    try {
      return GBK.decode(bytes);
    } catch {
      return bytes.toString("latin1");
    }
  }
}

/** Console colour codes are dropped so log files stay readable plain text. */
export function stripAnsi(text: string): string {
  return text.includes("\u001b") ? stripVTControlCharacters(text) : text;
}

/** Bind a pipe server and resolve once it is listening. */
const listen = (server: Server, path: string) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });

/**
 * Daemon body: own both pipes, append engine output to the log file, and exit
 * once the engine (pid from pidFile) is gone and no pipe is connected.
 */
export async function runLogDaemon(opts: LogDaemonOptions): Promise<number> {
  mkdirSync(dirname(opts.logFile), { recursive: true });
  writeFileSync(opts.logFile, "", { flag: "a" });

  let pending = Buffer.alloc(0);
  const append = (chunk: Buffer): void => {
    pending = Buffer.concat([pending, chunk]);
    let index = pending.indexOf(0x0a);
    while (index >= 0) {
      const line = decodeLine(pending.subarray(0, index));
      pending = pending.subarray(index + 1);
      appendFileSync(opts.logFile, `${stripAnsi(line).replace(/\r$/, "")}\n`);
      index = pending.indexOf(0x0a);
    }
  };

  const outServer: Server = createServer((socket: Socket) => {
    socket.on("data", (chunk: Buffer) => append(chunk));
    socket.on("error", () => {
      /* engine closed abruptly: keep the daemon alive */
    });
  });
  // The engine reads console commands from us. Holding this socket is what
  // makes the hosted console a two-way channel: writing a line here runs it on
  // the server console (verified with `status`), with console authority.
  let engineInput: Socket | null = null;
  const inServer: Server = createServer((socket: Socket) => {
    engineInput = socket;
    socket.on("error", () => {
      /* ignore */
    });
    socket.on("close", () => {
      if (engineInput === socket) engineInput = null;
    });
  });

  /** Loopback-only command endpoint; first line must be `AUTH <token>`. */
  // `--ctl-port 0` means "bind an ephemeral loopback port", not "disabled":
  // presence of the option is what enables the channel.
  const ctlServer: Server | null =
    typeof opts.ctlPort === "number" && opts.ctlPort >= 0
      ? createServer((client: Socket) => {
          let buffer = "";
          let authorised = false;
          client.on("error", () => {
            /* client went away */
          });
          client.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            for (;;) {
              const newline = buffer.indexOf("\n");
              if (newline < 0) break;
              const line = buffer.slice(0, newline).replace(/\r$/, "");
              buffer = buffer.slice(newline + 1);
              if (!authorised) {
                authorised = line.trim() === `AUTH ${opts.ctlToken ?? ""}`;
                client.write(authorised ? "OK auth\n" : "ERR auth\n");
                continue;
              }
              if (line.trim().length === 0) continue;
              if (line.trim() === "PING") {
                client.write(engineInput ? "OK engine\n" : "ERR no-engine\n");
                continue;
              }
              if (!engineInput) {
                client.write("ERR no-engine\n");
                continue;
              }
              engineInput.write(`${line}\n`);
              client.write("OK sent\n");
            }
          });
        })
      : null;

  await listen(outServer, opts.outPipe);
  await listen(inServer, opts.inPipe);
  if (ctlServer) {
    const bound = Promise.withResolvers<void>();
    ctlServer.once("error", bound.reject);
    ctlServer.listen(opts.ctlPort ?? 0, "127.0.0.1", () => bound.resolve());
    await bound.promise;
  }

  // Tell the caller the pipes exist (and on which control port); only then
  // does it spawn the engine.
  const boundAddress = ctlServer ? ctlServer.address() : null;
  const boundPort = boundAddress && typeof boundAddress === "object" ? boundAddress.port : 0;
  process.stdout.write(`READY ${boundPort}\n`);

  let enginePid = 0;
  const started = Date.now();
  const idleDeadline = 10 * 60 * 1000;

  /**
   * 临时封禁到期：由守护（而不是某个已经退出的进程）把 `unban "<id64>"` 写进引擎输入管道。
   * 这是"封 30 分钟"里"到点解封"那一半 —— 不写这句，台账上的到期就是假的。
   * 解封行同时记进日志分片，好让面板按时间线看见它。
   */
  const sweepExpiredBans = (): void => {
    if (!opts.root || !engineInput) return;
    let due: ModerationEntry[];
    try {
      due = dueEntries(loadModeration(opts.root), Date.now());
    } catch {
      return;
    }
    for (const entry of due) {
      try {
        engineInput.write(`unban "${entry.id64}"\n`);
      } catch {
        continue;
      }
      markUnbanned(opts.root, entry.id, Date.now());
      appendFileSync(
        opts.logFile,
        `[r5-server] 临时封禁到期（${entry.minutes} 分钟）：已发送 unban "${entry.id64}"${entry.name.length > 0 ? `（${entry.name}）` : ""}\n`,
      );
    }
  };

  for (;;) {
    await Bun.sleep(2000);
    sweepExpiredBans();
    if (enginePid === 0) {
      if (existsSync(opts.pidFile)) {
        const text = await Bun.file(opts.pidFile).text();
        const parsed = Number.parseInt(text.trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0) enginePid = parsed;
      } else if (Date.now() - started > idleDeadline) {
        break;
      }
      continue;
    }
    let alive = true;
    try {
      process.kill(enginePid, 0);
    } catch {
      alive = false;
    }
    if (!alive) {
      // let any last bytes land before leaving
      await Bun.sleep(1500);
      break;
    }
  }

  outServer.close();
  inServer.close();
  ctlServer?.close();
  return 0;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------- internal worker 契约
//
// 面向服主的入口只有一个：桌面面板。但有三类活必须在**独立进程**里跑 —— 提权与
// 系统级改动（主机配置 / 自启）、计划任务触发的启动、后台常驻的日志守护与模拟引擎。
// 它们全部以 `<宿主前缀> <操作> [参数...]` 重新进入 `src/worker-entry.ts`：
//
//   打包：<r5-server.exe> --worker setup --ports 37015
//   源码：bun run <仓库>/src/worker-entry.ts setup --ports 37015
//
// 前缀由宿主给（`R5_SERVER_DAEMON`）：打包后的面板进程是 GUI，`process.argv` 是面板
// 自己的；源码运行时解释器是 bun、参数里得带上入口文件。这两种差别只有宿主知道。

/** 宿主给的 worker argv 前缀（JSON 数组）：`workerCommand()` 的唯一权威来源。 */
export const DAEMON_ENV = "R5_SERVER_DAEMON";
/** 只有打包（嵌入式）进程才为 `1`：区分"参数在环境里"与"参数在 argv 里"。 */
export const PACKAGED_ENV = "R5_SERVER_PACKAGED";
/** 打包宿主把 `--worker` 之后的参数镜像成 JSON 数组（嵌入运行看不到原始 argv）。 */
export const WORKER_ARGS_ENV = "R5_SERVER_WORKER_ARGS";
/** 打包宿主重新进入 worker 的 argv 标记。 */
export const WORKER_MARKER = "--worker";

/**
 * 内部 worker 的操作名。这些字符串**跨进程**（计划任务里钉死的就是它们），
 * 所以只在唯一的登记表里写一遍：spawn 侧与 worker 侧的写错会在类型层面失配。
 */
export const WORKER_OPS = {
  setup: "setup",
  autostart: "autostart",
  start: "start",
  logDaemon: "__logd",
  devEngine: "__dev-engine",
  devStop: "__dev-stop",
} as const;

/** 打包（嵌入式）进程：宿主设的标记，不靠猜可执行文件叫什么名字。 */
export function isPackaged(): boolean {
  return process.env[PACKAGED_ENV] === "1";
}

/**
 * 重新进入内部 worker 的完整命令行。
 *
 * 前缀只认宿主给的 `R5_SERVER_DAEMON`；没有它（源码里直接跑、或开发时不经宿主起
 * Vite）时按运行形态兜底：源码是"用当前解释器跑 worker 入口文件"，打包是宿主自己的
 * `--worker` 模式。这里刻意**不**看 `process.execPath` 的文件名去猜是不是 bun：
 * 名字认少一个，子进程就会把操作名当成脚本名去找（`Script not found "__logd"`）。
 */
export function workerCommand(extraArgs: string[]): string[] {
  return [...workerPrefix(), ...extraArgs];
}

function workerPrefix(): string[] {
  const parsed = jsonStringArray(process.env[DAEMON_ENV]);
  if (parsed !== null && parsed.length > 0) return parsed;
  // 与本文件同目录的 worker 入口：源码运行时它就在（`src/worker-entry.ts`），
  // 打包后不存在 —— 那正是"该走宿主自己的 --worker 模式"的判据。
  const entry = fileURLToPath(new URL("./worker-entry.ts", import.meta.url));
  if (!isPackaged() && existsSync(entry)) return [process.execPath, "run", entry];
  return [process.execPath, WORKER_MARKER];
}

/**
 * worker 进程自己的参数（不含宿主前缀）。
 *
 * 打包时**只**读宿主镜像的环境变量：嵌入运行里 argv 不是原始那份，而
 * `R5_SERVER_WORKER_ARGS` 是宿主为这一次调用设的。源码运行永远走 argv ——
 * 否则从打包的父进程继承下来的旧参数会盖掉自己的参数。
 */
export function workerArgs(): string[] {
  if (isPackaged()) {
    const mirrored = jsonStringArray(process.env[WORKER_ARGS_ENV]);
    if (mirrored !== null) return mirrored;
  }
  return process.argv.slice(2);
}

/**
 * 给子进程的环境：**删掉**继承来的 `R5_SERVER_WORKER_ARGS`。
 *
 * 它是"当前这次调用"的参数镜像，只对当前进程有意义；子进程的参数由它自己的 argv
 * 前缀决定。宿主每次调用都会重设这个变量，这里只是不给脏值任何继承的机会。
 */
export function workerSpawnEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = { ...process.env, ...extra } as Record<string, string>;
  delete env[WORKER_ARGS_ENV];
  return env;
}

/** JSON 字符串数组；不是这个形状就当没给（宿主给了坏值不该让子进程乱跑）。 */
function jsonStringArray(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((part) => typeof part === "string")) return parsed;
  } catch {
    /* 坏值当没给 */
  }
  return null;
}

/**
 * 按 Windows 的参数规则给一段参数加引号（`CommandLineToArgvW` 认的形式）。
 *
 * 需要它的都是"把一整条 worker 命令行交给别人"的地方：`schtasks /TR`、`Start-Process`
 * 的 `-ArgumentList`（PowerShell 只把数组用空格拼起来，不替你加引号）。引号与反斜杠要
 * 一起处理，否则含空格的路径会断成两段、JSON 参数里的引号会跑掉。
 *
 * 放在这里（而不是 `win.ts`）是因为 win.ts ↔ dev-host.ts 互相引用：计划任务的两处
 * 构造（commands.ts 与 dev-host.ts）都要用它，放在共用叶子模块才不会造出新的环。
 */
export function windowsArg(part: string): string {
  if (part.length > 0 && !/[\s"]/.test(part)) return part;
  let out = '"';
  let backslashes = 0;
  for (const char of part) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      // 引号前的反斜杠要翻倍，再加一个转义引号。
      out += `${"\\".repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    out += "\\".repeat(backslashes) + char;
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

/** Last `count` lines of a file, read from the tail without loading everything. */
export function readTail(path: string, count: number): string[] {
  return readTailState(path, count).lines;
}

/**
 * 最后一个整行的结束位置：`cut` 是不含行尾符的字符下标（-1 = 窗口里没有换行），
 * `terminator` 是行尾符占的字节数（`\n` 或 `\r\n`）。
 */
function lastLineEnd(text: string): { cut: number; terminator: number } {
  const newline = text.lastIndexOf("\n");
  if (newline < 0) return { cut: -1, terminator: 0 };
  const crlf = newline > 0 && text[newline - 1] === "\r";
  return { cut: crlf ? newline - 1 : newline, terminator: crlf ? 2 : 1 };
}

/**
 * 尾部整窗 + 已读到的字节位置。
 *
 * `offset` 永远落在**整行**边界上：末行如果还没写完（没有换行收尾），它留给下一次读，
 * 水位线停在它的起点 —— 面板据此增量跟日志（`readDelta`），半行不会被当成整行，也不会
 * 重复显示。
 */
export function readTailState(path: string, count: number): { lines: string[]; offset: number } {
  if (!existsSync(path)) return { lines: [], offset: 0 };
  const size = statSync(path).size;
  const windowBytes = Math.min(size, Math.max(64 * 1024, count * 400));
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(windowBytes);
    readSync(fd, buffer, 0, windowBytes, size - windowBytes);
    const text = buffer.toString("utf8");
    const { cut, terminator } = lastLineEnd(text);
    // 窗口里一个换行都没有（latest.txt 这类单行文件）：整段算一行，水位线到文件末尾。
    if (cut < 0) return { lines: trimTail(text.split(/\r?\n/), count), offset: size };
    const complete = text.slice(0, cut);
    const lines = complete.split(/\r?\n/);
    if (size > windowBytes && lines.length > 0) lines.shift(); // partial first line
    return {
      lines: trimTail(lines, count),
      offset: size - windowBytes + Buffer.byteLength(complete, "utf8") + terminator,
    };
  } finally {
    closeSync(fd);
  }
}

/** 丢掉尾部空行，只留最后 `count` 行（一个窗口里可能装得下更多行）。 */
function trimTail(lines: string[], count: number): string[] {
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-count);
}

/**
 * `offset` 之后新增的行与新的水位线。
 *
 * 日志只会追加，所以只看水位线后面的字节；文件被换掉或截断（size < offset）返回 null，
 * 调用方按"新文件"整窗重读。末行没写完时它留给下一次读 —— 水位线必须一直停在整行边界上，
 * 否则半行会变成一行、还会把断掉的多字节字符写进去。
 */
export function readDelta(path: string, offset: number): { lines: string[]; offset: number } | null {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  if (size < offset) return null;
  if (size === offset) return { lines: [], offset };
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    const text = buffer.toString("utf8");
    const { cut, terminator } = lastLineEnd(text);
    if (cut < 0) return { lines: [], offset };
    const complete = text.slice(0, cut);
    return { lines: complete.split(/\r?\n/), offset: offset + Buffer.byteLength(complete, "utf8") + terminator };
  } finally {
    closeSync(fd);
  }
}
