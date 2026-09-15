/**
 * 控制台回执分类：引擎到底怎么回答的。
 *
 * 托管控制台没有 RCON 那套状态码，唯一可信的信号是引擎自己的输出。实测
 * （r5f-dedi 1.0.13）只有四类：
 *
 *   unknown  `Command 'x' doesn't exist; request 'x' ignored` / `help:  no cvar or command named x`
 *   usage    引擎明确拒绝：`usage 'sv_addbot': name(string) teamid(int)` / `Usage:  help <cvarname>` /
 *            `[BRIDGE-MODE] rejected: playlist 'x' not in the loaded playlist file`
 *   success  明确动作行，例如 `Kicked '1' from server`、`CHostState::State_ChangeLevelMP: …`
 *   silent   命令存在但一个字都不回（`ban`/`banid`/`unban`/`banlist_reload`/`sv_cheats`/cvar 赋值）
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

/**
 * 「不存在」不止一种说法（均为实测 1.0.13）：
 *   `Command 'mute' doesn't exist; request 'mute' ignored` —— 发命令
 *   `help:  no cvar or command named mute`                     —— 查 cvar/命令
 * 第二种曾经被报成 silent —— 那等于把"没有这个东西"说成"命令存在但没回话"。
 */
const UNKNOWN_PATTERNS: RegExp[] = [/Command '(.+)' doesn't exist/, /^help:\s+no cvar or command named\b/i];

/**
 * 引擎明确拒绝执行（实测）：
 *   `usage 'sv_addbot': name(string) teamid(int)`                      —— 参数不合法
 *   `[BRIDGE-MODE] rejected: playlist 'x' not in the loaded playlist file`
 *   `BanSystem_ConvertAddress: Failed to convert provided network address "…"`
 *   `[BAN] busy-reject slot=1 uid=…`
 * 这些行以前落进 silent（"已发送"）—— 明明失败了却报成功，本批修掉。
 */
const REFUSED_PATTERNS: RegExp[] = [
  /^\s*usage[:\s]/i,
  /^rejected:\s+/i,
  /^BanSystem_ConvertAddress:\s*Failed to convert/,
  /^busy-reject\b/i,
];

/**
 * 表驱动：后续新增"明确动作行"往这里加即可（全部实测）：
 *   `Kicked '1' from server`                                   —— 踢人
 *   `hostname: …`                                             —— status 块头
 *   `CHostState::State_ChangeLevelMP: Changing multiplayer level to: 'x'`
 *   `Native(E):CHostState::State_NewGame: Loading level: 'x'`
 *   `Starting server with name: "x" map: "y" mode: "z"`        —— bridge_setmode 回执
 *   `"bridge_chat_announce" = "1" ( def. "0" )`                —— help <cvar> 读了值
 *   `"ban"  release - Bans a client …`                          —— help <命令> 找到了
 */
const SUCCESS_PATTERNS: RegExp[] = [
  /^Kicked '(.+)' from server/,
  /^hostname\s*:/i,
  /^CHostState::State_(?:NewGame|ChangeLevelMP):/,
  /^Starting server with name: ".+" map: ".+" mode: ".+"/,
  /^"[A-Za-z0-9_]+"(?:\s|=|$)/,
];

/** 优先级 unknown > refused > success > silent；`detail` 取首条命中正文。 */
export function classifyReceipt(lines: string[]): Receipt {
  const body = lines.map(normaliseLogLine).filter((line) => line.length > 0);
  const firstMatch = (patterns: RegExp[]): string | undefined => {
    for (const pattern of patterns) {
      const hit = body.find((line) => pattern.test(line));
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  const unknown = firstMatch(UNKNOWN_PATTERNS);
  if (unknown !== undefined) return { kind: "unknown", detail: unknown, lines: body };
  const usage = firstMatch(REFUSED_PATTERNS);
  if (usage !== undefined) return { kind: "usage", detail: usage, lines: body };
  const success = firstMatch(SUCCESS_PATTERNS);
  if (success !== undefined) return { kind: "success", detail: success, lines: body };
  return { kind: "silent", detail: "", lines: body };
}
