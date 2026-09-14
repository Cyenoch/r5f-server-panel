/**
 * 控制台回执分类：引擎到底怎么回答的。
 *
 * 托管控制台没有 RCON 那套状态码，唯一可信的信号是引擎自己的输出。实测
 * （r5f-dedi 1.0.13）只有四类：
 *
 *   unknown  `Command 'x' doesn't exist; request 'x' ignored` —— 命令不存在
 *   usage    `usage 'sv_addbot': name(string) teamid(int)` / `Usage:  help <cvarname>`
 *   success  明确动作行，例如 `Kicked '1' from server`
 *   silent   命令存在但一个字都不回（`ban`/`banid`/`unban`/`banlist_reload`/
 *            `sv_cheats`/`bridge_chat_announce`）
 *
 * 静默是一等公民：它**不是**成功。谁也不能把"没回话"说成"执行成功"。
 * 本模块是纯函数，不碰 IO，方便 UI 与 CLI 共用同一套判定。
 */

export type ReceiptKind = "success" | "unknown" | "usage" | "silent";
export type Receipt = { kind: ReceiptKind; detail: string; lines: string[] };

/** 引擎日志行前缀：`[12.345] `、`Native(S):`（`Native(E):[dt_extend] …` 也吃）。 */
const TIMESTAMP = /^\[\d+(?:\.\d+)?\]\s*/;
const NATIVE = /^Native\([A-Za-z0-9]+\):\s*/;
/**
 * 诊断标签：`[DETOUR] …`、`[FIRE-CLOCK] …`、`[ZIP-ATTACH] …`、`[BRIDGE-SCMD] …`、
 * `Native(E):[dt_extend] …` 里的 `[dt_extend]`。只吃全大写或全小写的标签，
 * 所以公告文案里的 `[Flowstate]` 不会被误删。
 */
const TAG = /^\[(?:[A-Z][A-Z0-9_-]*|[a-z][a-z0-9_]*)\]\s*/;

/** 去掉时间戳/Native 通道/诊断标签，保留正文（判定与显示都用它）。 */
export function normaliseLogLine(line: string): string {
  let text = line.trim().replace(TIMESTAMP, "").replace(NATIVE, "");
  for (;;) {
    const stripped = text.replace(TAG, "");
    if (stripped === text) break;
    text = stripped;
  }
  return text.trim();
}

const UNKNOWN_PATTERN = /Command '(.+)' doesn't exist/;
const USAGE_PATTERN = /^\s*usage[:\s]/i;

/**
 * 表驱动：后续新增"明确动作行"往这里加即可。
 * `Kicked` 是实测的踢人回执；`hostname:` 是 `status` 块的头（引擎确实回了内容，
 * 把它报成"无回执"就是撒谎 —— ticket 02 允许这么识别）。
 */
const SUCCESS_PATTERNS: RegExp[] = [/^Kicked '(.+)' from server/, /^hostname\s*:/i];

/** 优先级 unknown > usage > success > silent；`detail` 取首条命中正文。 */
export function classifyReceipt(lines: string[]): Receipt {
  const body = lines.map(normaliseLogLine).filter((line) => line.length > 0);
  const firstMatch = (pattern: RegExp): string | undefined => body.find((line) => pattern.test(line));
  const unknown = firstMatch(UNKNOWN_PATTERN);
  if (unknown !== undefined) return { kind: "unknown", detail: unknown, lines: body };
  const usage = firstMatch(USAGE_PATTERN);
  if (usage !== undefined) return { kind: "usage", detail: usage, lines: body };
  for (const pattern of SUCCESS_PATTERNS) {
    const success = firstMatch(pattern);
    if (success !== undefined) return { kind: "success", detail: success, lines: body };
  }
  return { kind: "silent", detail: "", lines: body };
}
