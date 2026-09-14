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

  for (;;) {
    await Bun.sleep(2000);
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
  const exe = process.execPath;
  const leaf = exe.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (leaf === "bun.exe" || leaf === "bun") {
    const script = process.argv[1];
    if (script && existsSync(script)) return [exe, "run", script, ...extraArgs];
  }
  return [exe, ...extraArgs];
}

/** Last `count` lines of a file, read from the tail without loading everything. */
export function readTail(path: string, count: number): string[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const windowBytes = Math.min(size, Math.max(64 * 1024, count * 400));
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(windowBytes);
    readSync(fd, buffer, 0, windowBytes, size - windowBytes);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (size > windowBytes && lines.length > 0) lines.shift(); // partial first line
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-count);
  } finally {
    closeSync(fd);
  }
}
