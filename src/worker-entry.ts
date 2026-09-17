/**
 * 内部 worker 的进程入口：宿主（打包的 exe / 源码里的 bun）重新进入内部操作的唯一落脚点。
 *
 * 打包：宿主看到 `--worker` 就把后面的参数镜像进 `R5_SERVER_WORKER_ARGS`，然后在本进程里
 * 跑这段入口（见 native 侧与 `workerCommand()`）。嵌入运行时**只有显式退出这一条路**：
 * VM 自己不会因为"操作做完了"而停 —— 所以这里总是 `process.exit()`。
 *
 * 退出码：嵌入式运行里 VM 的退出码只有 u8，而 UAC 取消是 1223，截断后就分不清"取消"和
 * "真的失败"了。所以在打包进程里先把**完整**退出码以一帧内部结果帧交给宿主
 * （12 字节：u32LE 载荷长度 8｜ASCII `R5WX`｜u32LE 退出码），宿主读走它、等 VM 退出，
 * 再按完整退出码返回值；随后 `process.exit(0/1)` 只负责把 VM 停掉。这一帧是**终端结果**，
 * 不是渲染数据 —— worker 不订阅桥、不发任何界面帧。
 *
 * 源码运行没有桥：`process.exit(code)` 原样带上退出码（和任何一个命令行程序一样）。
 */
import { ensureDevFixtures } from "./dev-fixtures";
import { isPackaged, workerArgs } from "./tap";
import { red } from "./ui";
import { initConsole } from "./win";
import { runWorker } from "./worker";

/** 结果帧的魔数：宿主用它把"worker 的退出码"与任何其它字节区分开。 */
const RESULT_MAGIC = [0x52, 0x35, 0x57, 0x58]; // "R5WX"

/**
 * 把一帧交给宿主。返回 false = 没有桥或桥拒绝了这一帧（宿主没按约定装桥 / 传输已关），
 * 调用方据此说明"退出码只能按 0/1 交回"，而不是假装成功。
 */
function submitToHost(frame: Uint8Array): boolean {
  const host: unknown = Reflect.get(globalThis, "__solidGpuiHost");
  if (typeof host !== "object" || host === null || !("submit" in host)) return false;
  const submit: unknown = host.submit;
  if (typeof submit !== "function") return false;
  try {
    return Boolean(submit.call(host, frame));
  } catch {
    return false;
  }
}

/**
 * 把完整退出码交给宿主：12 字节帧 = u32LE 载荷长度(8) + `R5WX` + u32LE 退出码。
 * 宿主读走后按**完整**码返回（1223 这种大于 255 的码不会被截断）。
 */
function reportExitCode(code: number): void {
  const frame = new Uint8Array(12);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 8, true);
  frame.set(RESULT_MAGIC, 4);
  view.setUint32(8, code >>> 0, true);
  if (!submitToHost(frame)) {
    process.stderr.write(`${red("内部 worker：宿主没有接受结果帧，退出码只能按 0/1 交回。")}\n`);
  }
}

function exitWith(code: number): never {
  if (isPackaged()) {
    reportExitCode(code);
    // VM 的退出码只有 u8：真正的码已经随结果帧交出去了，这里只负责把 VM 停掉。
    process.exit(code === 0 ? 0 : 1);
  }
  process.exit(code);
}

initConsole();
// 开发沙箱必须在第一次读状态之前就位（版本目录 / 状态文件都由它补齐）。
ensureDevFixtures();

let code: number;
try {
  code = await runWorker(workerArgs());
} catch (err) {
  // 报错信息（而不是栈）：宿主把 stderr 原样带进"操作记录"。
  process.stderr.write(`${red(err instanceof Error ? err.message : String(err))}\n`);
  code = 1;
}
exitWith(code);
