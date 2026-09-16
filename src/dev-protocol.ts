/**
 * Dev 模式（R5F_DEV=1）本地模拟实例的共享协议：快照文件的形状，以及"怎么让它退出"。
 *
 * 停止路径刻意**不**用 `process.kill(runtime.pid)`：那个 pid 在我们拿到它之后可能已经
 * 被系统回收给了别的进程，对着一个可能被复用的 OS pid 发信号，等于随机杀别人的进程。
 * 模拟引擎监听一个真实的 loopback 控制端口，停止请求一路走到引擎自己收尾（清定时器、
 * 关端口、删快照）为止 —— 要么确认它停了，要么明确说没停。
 *
 * 本模块只被 dev 路径引用（CLI 的隐藏命令、模拟引擎、Windows 适配层的 dev 分支）。
 * 两个进程都要用到的东西只有一个来源：这里的类型与常量。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { DEV_MODE, DEV_ROOT } from "./dev";
import { loadState } from "./state";
import { selfCommand } from "./tap";

/** 模拟引擎写、面板与 CLI 读的运行标识。就这五个字段，没有隐藏字段。 */
export type DevEngineSnapshot = {
  /** 模拟引擎进程的 pid。 */
  pid: number;
  /** 模拟的游戏 UDP 端口（**没有真的绑**，只用于标题/状态显示）。 */
  port: number;
  /** 模拟的版本目录（DEV_ROOT 里的 fixture）。 */
  versionPath: string;
  /** 引擎启动时刻（ISO）。 */
  startedAt: string;
  /** 引擎窗口标题，`<名字> - n/60 Players (模式 on 地图) - x% Server CPU (y msec on frame z)`。 */
  title: string;
};

// --------------------------------------------------------------- 快照文件

/** 快照路径固定落在 DEV_ROOT 里：调用方无权改（改了就不认）。 */
export function devEngineSnapshotPath(): string {
  return join(DEV_ROOT, "dev-engine.json");
}

function readPositiveInt(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** 读快照；缺失、损坏或字段类型不对都是 null（调用方据此判定"没有实例"）。 */
export function readDevEngineSnapshot(): DevEngineSnapshot | null {
  const path = devEngineSnapshotPath();
  if (!existsSync(path)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const pid = readPositiveInt(raw.pid);
  const port = readPositiveInt(raw.port);
  const versionPath = typeof raw.versionPath === "string" ? raw.versionPath : "";
  const startedAt = typeof raw.startedAt === "string" ? raw.startedAt : "";
  if (pid === 0 || port === 0 || versionPath.length === 0 || startedAt.length === 0) return null;
  return {
    pid,
    port,
    versionPath,
    startedAt,
    title: typeof raw.title === "string" ? raw.title : "",
  };
}

/** 原子写（临时文件 + rename）：面板随时可能读到它，不能读到半截 JSON。 */
export function writeDevEngineSnapshot(snapshot: DevEngineSnapshot): void {
  const path = devEngineSnapshotPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** 优雅退出时清掉快照（崩溃留下的陈旧快照由启动侧按 pid 存活判定忽略）。 */
export function removeDevEngineSnapshot(): void {
  const path = devEngineSnapshotPath();
  try {
    rmSync(path, { force: true });
    rmSync(`${path}.tmp`, { force: true });
  } catch {
    /* 删不掉也只能算了：启动侧的存活判定仍然成立 */
  }
}

// ----------------------------------------------------------- 控制通道协议

/**
 * 控制通道的线上文本（与 `src/tap.ts` 里日志守护的实现一致：先 `AUTH <token>`，
 * 之后一行一条命令，每条命令回一行 `OK sent`）。
 */
export const DEV_AUTH_OK = "OK auth";
export const DEV_AUTH_ERR = "ERR auth";
export const DEV_PING = "PING";
export const DEV_PONG = "OK engine";
export const DEV_SENT = "OK sent";
/** 停止命令与服务端的确认行（`OK sent` 之后的第二步）。 */
export const DEV_STOP_COMMAND = "__dev_stop";
export const DEV_STOP_ACK = "OK stopping";
/** 隐藏 CLI 子命令名：`<self> __dev-stop <pid>`。 */
export const DEV_STOP_CLI = "__dev-stop";

const LOOPBACK = "127.0.0.1";
/** 停止请求的总预算：够引擎收尾，又不至于让 CLI 卡住。 */
export const DEV_STOP_TIMEOUT_MS = 5000;
/** dev_disconnect 丢连接后重试的间隔。 */
const RETRY_DELAY_MS = 120;
/** 连接层失败的重试次数（dev_disconnect 会丢掉下一次连接）。 */
const MAX_ATTEMPTS = 3;
/** `__dev-stop` 子进程的硬上限：必须比 requestDevStop 的预算大。 */
const SPAWN_TIMEOUT_MS = DEV_STOP_TIMEOUT_MS + 3000;

type StopAttempt = "stopped" | "auth" | "retry";

/**
 * 一次停止尝试：鉴权 → 发 `__dev_stop` → 等引擎自己关连接。
 *
 * 「关了就算停」只在**收到过非 ERR 回执之后**成立：那时引擎已经在收尾（它先关监听、
 * 再删快照、最后断开连接），连接断开是"收尾完成"的信号。没有回执就断开只算连接层
 * 失败，交给上层重试。
 */
function stopOnce(port: number, token: string, budgetMs: number): Promise<StopAttempt> {
  const outcome = Promise.withResolvers<StopAttempt>();
  const socket = connect({ host: LOOPBACK, port });
  let buffer = "";
  let authed = false;
  let acked = false;
  let settled = false;
  const finish = (value: StopAttempt): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    outcome.resolve(value);
  };
  const timer = setTimeout(() => finish("retry"), budgetMs);
  socket.on("connect", () => socket.write(`AUTH ${token}\n`));
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!authed) {
        if (line !== DEV_AUTH_OK) {
          finish(line === DEV_AUTH_ERR ? "auth" : "retry");
          return;
        }
        authed = true;
        socket.write(`${DEV_STOP_COMMAND}\n`);
        continue;
      }
      if (line.startsWith("ERR")) {
        finish("retry");
        return;
      }
      acked = line === DEV_STOP_ACK;
    }
  });
  socket.on("error", () => finish(acked ? "stopped" : "retry"));
  socket.on("close", () => finish(acked ? "stopped" : "retry"));
  return outcome.promise;
}

/**
 * 让指定 pid 的模拟实例停下来。
 *
 * 身份判定要**三处一致**才动手：状态文件里的 `runtime.pid`、快照里的 `pid`、以及
 * 调用方给的 pid —— 任何一处对不上都返回 false（宁可报"没停"，也不对着陌生端口发命令）。
 * 令牌与端口只从状态文件取：快照里没有它们，也就不会有人把它当成凭据。
 */
export async function requestDevStop(pid: number, timeoutMs = DEV_STOP_TIMEOUT_MS): Promise<boolean> {
  if (!DEV_MODE || !Number.isInteger(pid) || pid <= 0) return false;
  let runtime: { pid: number; ctlPort?: number; ctlToken?: string } | null = null;
  try {
    runtime = loadState().runtime;
  } catch {
    return false; // 状态文件损坏：读不到身份，就别乱发停止请求
  }
  if (!runtime || runtime.pid !== pid) return false;
  const snapshot = readDevEngineSnapshot();
  if (!snapshot || snapshot.pid !== pid) return false;
  const port = runtime.ctlPort ?? 0;
  const token = runtime.ctlToken ?? "";
  if (port <= 0 || token.length === 0) return false;
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const budget = deadline - Date.now();
    if (budget <= 0) return false;
    const result = await stopOnce(port, token, budget);
    if (result === "stopped") return true;
    if (result === "auth") return false; // 令牌不对：重试只是重复失败
    await Bun.sleep(RETRY_DELAY_MS);
  }
  return false;
}

/**
 * 同步版停止：起一个隐藏 CLI 子进程（`__dev-stop <pid>`）走完整流程，按退出码判定。
 *
 * 同步是刻意的：调用方（Windows 适配层的 `killTree`）本身是同步接口。绝不在此处
 * `process.kill` —— 见文件头。
 */
export function stopDevEngine(pid: number): boolean {
  if (!DEV_MODE || !Number.isInteger(pid) || pid <= 0) return false;
  const result = Bun.spawnSync(selfCommand([DEV_STOP_CLI, String(pid)]), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: SPAWN_TIMEOUT_MS,
  });
  return result.exitCode === 0;
}
