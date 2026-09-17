/** 内嵌打包脚本共用的进程、错误与 JSON 边界工具：外部命令怎么跑、外部 JSON 怎么取字段。 */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

/** 前置条件或契约不满足。与内部缺陷区分开：顶层只据实报告，不打印调用栈。 */
export class BuildFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildFailure";
  }
}

export function fail(message: string): never {
  throw new BuildFailure(message);
}

/** JSON 对象边界：先断言成具名记录，再逐字段用窄化读取器取值。 */
export type JsonObject = Record<string, unknown>;

export function parseJsonObject(text: string, what: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${what} 不是 JSON 对象`);
  return value as JsonObject;
}

export function stringMapField(source: JsonObject, key: string, what: string): Record<string, string> {
  const value = source[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${what} 不是 JSON 对象`);
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string") fail(`${what}.${name} 不是字符串`);
    result[name] = entry;
  }
  return result;
}

/** 调用方的 cargo wrapper / RUSTFLAGS 属于「外层」：漏进固定工具链的构建就会换错编译器与链接策略。 */
const HOST_TOOLCHAIN_VARIABLES = [
  "RUSTC",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "CLIPPY_ARGS",
  "RUSTFLAGS",
  "CARGO_ENCODED_RUSTFLAGS",
  "CARGO_MAKEFLAGS",
  "SOLID_GPUI_BUN_CHECK_ONLY",
] as const;

export interface RunOptions {
  readonly cwd: string;
  /** 附加环境变量；值为 undefined 表示删除继承来的同名变量。 */
  readonly env?: Record<string, string | undefined>;
  /** stdout 去向（stderr 始终继承）：capture 读回短输出，ignore 丢弃大输出。 */
  readonly stdout?: "inherit" | "capture" | "ignore";
  /** 清掉 HOST_TOOLCHAIN_VARIABLES 里未被显式指定的变量：固定工具链的构建必须打开。 */
  readonly pinnedToolchain?: boolean;
}

/** 跑一条外部命令；非零退出即抛错。返回（capture 时的）stdout。 */
export async function run(command: readonly string[], options: RunOptions): Promise<string> {
  console.error(`  $ ${command.map((argument) => JSON.stringify(argument)).join(" ")}`);
  const environment: Record<string, string | undefined> = { ...process.env };
  if (options.pinnedToolchain) {
    for (const key of HOST_TOOLCHAIN_VARIABLES) {
      if (options.env?.[key] === undefined) delete environment[key];
    }
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  if (process.platform === "win32") {
    // Bun 的测试源码含长文件名；只配置本次构建，不修改用户或系统 Git 设置。
    const count = Number(environment.GIT_CONFIG_COUNT ?? 0);
    if (!Number.isInteger(count) || count < 0) fail("GIT_CONFIG_COUNT 必须是非负整数");
    environment.GIT_CONFIG_COUNT = String(count + 1);
    environment[`GIT_CONFIG_KEY_${count}`] = "core.longpaths";
    environment[`GIT_CONFIG_VALUE_${count}`] = "true";
  }
  const mode = options.stdout ?? "inherit";
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: environment,
    stdin: "ignore",
    stdout: mode === "capture" ? "pipe" : mode,
    stderr: "inherit",
  });
  const [stdout, status] = await Promise.all([
    mode === "capture" ? new Response(child.stdout).text() : "",
    child.exited,
  ]);
  if (status !== 0) fail(`${command[0]} 执行失败（退出码 ${status}）：${command.join(" ")}`);
  return stdout.trim();
}

/** 路径是否存在（区分 ENOENT 与其他 I/O 错误：后者不能被当成「不存在」）。 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    // 只有「不存在」才是「不存在」；权限、I/O 错误必须冒泡，不能伪装成缺失。
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** 内容的 SHA-256 十六进制摘要（十六进制而非 Buffer：摘要要出现在日志与错误里）。 */
export function sha256Hex(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}
