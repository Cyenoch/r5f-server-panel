import { randomUUID } from "node:crypto";
/**
 * Hosted console tap: the same protocol the R5Flowstate launcher uses.
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
 * The pipe owner has to outlive the CLI (output must keep flowing after the
 * operator closes the terminal), so it runs as a detached `__logd` child that
 * appends every line to a log file. `logs -f` tails that file.
 */
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, statSync, closeSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
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
   * 临时封禁到期：由守护（而不是某个已退出的 CLI）把 `unban "<id64>"` 写进引擎输入管道。
   * 这是"封 30 分钟"里"到点解封"那一半 —— 不写这句，台账上的到期就是假的。
   * 解封行同时记进日志分片，好让 `logs` / 面板按时间线看见它。
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

/**
 * Command line that re-enters this CLI (used to spawn the detached log daemon).
 *
 * Compiled: the executable itself. Under `bun run src/cli.tsx` the executable is
 * bun, so the script has to be passed explicitly.
 */
export function selfCommand(extraArgs: string[]): string[] {
  return [...daemonPrefix(), ...extraArgs];
}

/**
 * 重新进入 CLI 的 argv 前缀。
 *
 * 从 `r5-server.exe` 或 `bun run src/cli.tsx` 自己启动时看 `process.execPath` 就够；
 * 但桌面端的宿主进程是 GUI，`process.argv[1]` 是面板 JS 而不是 CLI，所以宿主用
 * `R5_SERVER_DAEMON`（JSON 数组）显式告诉子进程该跑什么。
 */
function daemonPrefix(): string[] {
  const configured = process.env.R5_SERVER_DAEMON;
  if (configured) {
    try {
      const parsed: unknown = JSON.parse(configured);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((part) => typeof part === "string")) {
        return parsed;
      }
    } catch {
      /* 坏值退回自省 */
    }
  }
  const exe = process.execPath;
  const leaf = exe.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (leaf === "bun.exe" || leaf === "bun") {
    const script = process.argv[1];
    if (script && existsSync(script)) return [exe, "run", script];
  }
  return [exe];
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
