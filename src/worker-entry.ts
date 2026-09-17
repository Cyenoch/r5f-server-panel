/**
 * 内部 worker 的进程入口：宿主（打包的 exe / 源码里的 bun）重新进入内部操作的唯一落脚点。
 *
 * 打包：宿主看到 `--worker` 就把后面的参数镜像进 `R5_SERVER_WORKER_ARGS`，然后在本进程里
 * 跑这段入口（见 native 侧与 `workerCommand()`）。嵌入运行时**只有显式退出这一条路**：
 * VM 自己不会因为"操作做完了"而停 —— 所以这里总是 `process.exit()`。
 *
 * 退出码：嵌入式运行里 VM 的退出码只有 u8，而 UAC 取消是 1223，截断后就分不清"取消"和
 * "真的失败"了。所以打包进程把**完整** u32 交给 SDK 的完成结果 API
 * （`@solid-gpui/core/embedded` 的 `completeEmbedded`）：宿主读
 * `EmbeddedBunAdapter::result()` 拿到全宽的码，VM 自己的退出码只由 `process.exit(0/1)`
 * 决定、并与声明配对（非 0 码 → 1，native 侧按这条配对校验会话是否按约定结束）。
 *
 * 宿主不接受完成结果时**不静默降级**：截断成 0/1 会把"用户取消 UAC"报成"操作失败"，
 * 那正是这套 API 要消灭的误报，所以这里直接以 1 退出并把原因写进 stderr（宿主把它带进
 * 操作记录）。
 *
 * 源码/预览运行没有嵌入式桥：`process.exit(code)` 原样带上退出码（和任何一个命令行程序一样）。
 */
import { completeEmbedded, supportsEmbeddedCompletion } from "@solid-gpui/core/embedded";
import { ensureDevFixtures } from "./dev-fixtures";
import { isPackaged, workerArgs } from "./tap";
import { red } from "./ui";
import { initConsole } from "./win";
import { runWorker } from "./worker";

/** 有符号 i32 的下界：PowerShell / .NET / HRESULT 会给出负数。 */
const SIGNED_MIN = -0x8000_0000;
/** 无符号 u32 的上界：完成结果 API 与 Bun/OS 的原始形态。 */
const UNSIGNED_MAX = 0xffff_ffff;

/**
 * 完成结果 API 接受的码：整数，且落在 i32 / u32 两种写法的并集里。
 *
 * 退出码只有这两种来源：多数操作给 0/1/2/1223 这类无符号值；提权那一支把 Windows 的
 * **有符号** i32 带上来（PowerShell 的 `$p.ExitCode` 是 i32，`0xC0000409` 拿回来就是
 * -1073740791）。负数按无符号 u32 还原 —— 高位的码一个都不丢。
 *
 * 并集之外的取值一律拒绝：非整数不能用，`-4294967297` 这种越界负数若直接 `>>> 0` 会被
 * 悄悄按 2^32 取模（变成 0xffffffff），那正是"不截断"要防的事。
 */
function completionCode(code: number): number {
  if (!Number.isInteger(code) || code < SIGNED_MIN || code > UNSIGNED_MAX) {
    throw new Error(`内部 worker 的退出码必须是 i32/u32 范围内的整数，收到 ${String(code)}`);
  }
  return code < 0 ? code >>> 0 : code;
}

/** 把 worker 的退出码交回宿主。 */
function exitWith(code: number): never {
  if (!isPackaged()) process.exit(code);
  if (!supportsEmbeddedCompletion()) {
    process.stderr.write(
      `${red("内部 worker：宿主不接受完成结果（@solid-gpui/core/embedded），无法交回完整退出码。")}\n`,
    );
    process.exit(1);
  }
  completeEmbedded({ code: completionCode(code) });
  // VM 的退出码只有 u8：真正的码已经随完成结果交出去了，这里只负责把 VM 停掉。
  process.exit(code === 0 ? 0 : 1);
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
