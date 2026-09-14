# 02 · 控制台回执校验

- **Status**: `ready-for-human`（实现已完成；剩余步骤需要人或真人玩家在场）
- **Blocked by**: 无
- **归属文件**: `src/receipt.ts`（新，纯函数）、`src/commands.ts`、`src/cli.tsx`、`src/tui.tsx`
- **契约**: `spec.md` §契约 2（命令回执分类）

## Target

把"发出去了"升级成"引擎怎么回答的"。现在 `console` 无条件打印"已执行"，而实测存在三种真实结果（不存在 / 用法错误 / 静默），这不是小事：引擎对**不存在的命令会明确报错**，我们却在撒谎。

## 证据（实测回执样本）

| 命令                                                                                             | 引擎输出                                                         |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `echo-test` / `say hello` / `chat_announce` / `mute` / `find chat` / `cvarlist` / `say`          | `Command 'echo-test' doesn't exist; request 'echo-test' ignored` |
| `sv_addbot`（无参）                                                                              | `usage 'sv_addbot': name(string) teamid(int)`                    |
| `playlist_override_set`（无参）                                                                  | `usage: playlist_override_set <var> <value>`                     |
| `help`（无参）                                                                                   | `Usage:  help <cvarname>`                                        |
| `kick "1"`                                                                                       | `Kicked '1' from server`                                         |
| `ban "1"` / `banid 60 1` / `unban "0"` / `banlist_reload` / `sv_cheats` / `bridge_chat_announce` | 无输出（命令存在）                                               |

## Change

### 新模块 `src/receipt.ts`（纯函数，无 IO）

```ts
export type ReceiptKind = "success" | "unknown" | "usage" | "silent";
export type Receipt = { kind: ReceiptKind; detail: string; lines: string[] };

/** 去掉 "[12.345] Native(S):" / "[DETOUR] ..." 之类前缀，保留正文 */
export function normaliseLogLine(line: string): string;

/** 按优先级 unknown > usage > success > silent 分类 */
export function classifyReceipt(lines: string[]): Receipt;
```

- `unknown`：`/Command '(.+)' doesn't exist/`
- `usage`：`/^\s*usage[:\s]/i`（覆盖 `usage 'x': …`、`usage: …`、`Usage:  help <cvarname>`，大小写与多空格都要吃）
- `success`：明确动作行，首批：`/^Kicked '(.+)' from server/`；表驱动（`SUCCESS_PATTERNS`），后续可加
- `silent`：没有任何新行
- `detail` 取第一条命中的正文（去掉前缀），供 UI 直接显示

### `src/commands.ts`

```ts
/** 发送前的水位线：文件不存在返回 0 */
export async function logWatermark(path: string): Promise<number>;
/** 只读 offset 之后的新增行；文件被截断（size < offset）则从头读 */
export async function readAfter(path: string, offset: number): Promise<string[]>;
/** 发送 + 回执：等 waitMs（默认 1200）内的新增行，收到可分类行即返回 */
export async function consoleWithReceipt(state: State, line: string, waitMs?: number): Promise<Receipt>;
```

- `cmdConsole` 改为走 `consoleWithReceipt`；返回 `Receipt`（不再返回"已执行"）。
- 无托管控制台（缺 `ctlPort`/`ctlToken`）时抛既有错误，CLI 映射到退出码 2。
- **不要**把静默当成功：UI 文案必须是"已发送（引擎无回执）"，并在括号里给出该结论的依据（命令存在但未回话）。

### `src/cli.tsx`

```
console <command...> [--json] [--wait <ms>]
```

- 人读输出：`执行结果：成功（Kicked '1' from server）` / `执行结果：命令不存在（Command 'say' doesn't exist…）` / `执行结果：用法错误（usage 'sv_addbot': …）` / `执行结果：已发送（引擎无回执）`。
- `--json` → `{"command":"…","kind":"…","detail":"…","lines":[…]}`。
- 退出码：`0` = success/silent，`1` = unknown/usage，`2` = 无托管控制台。

### `src/tui.tsx`

- 动作输出在日志区按 kind 着色：success 绿、unknown/usage 红、silent 暗色；日志区头部 `⏳ …` 结束时显示同一结论。
- 玩家页/控制台行的动作沿用同一渲染路径（不要另写一套文案）。

## Acceptance

1. `console status` → 成功类（`players : …` 之类新增行虽非 success 模式，也要落到 `silent`→实际应显示"已发送（引擎无回执）"；若能识别 `hostname:` 头部则归 success —— 由实现决定，但**必须与引擎输出一致**）。
2. `console say hello` → 退出码 1，文案含"命令不存在"。
3. `console sv_addbot` → 退出码 1，文案含"用法错误"并回显引擎的 usage 原文。
4. `console bridge_chat_announce` → 退出码 0，文案"已发送（引擎无回执）"。
5. 面板里跑一次失败命令，红字出现在日志区，页面不消失。
6. 反复 `console status` 时，回执必须来自**本次**发送（水位线生效，不能匹配到上一条 status 的输出）。

## 验证配方

- 纯函数：用上表 6 条真实样本行做断言（脚本一次性运行后删除）。
- 端到端：`bun run src/cli.tsx start`（托管）→ 依次 `console` 上述命令 → 核对退出码 `echo $?`。
- 水位线：连续两次 `console status`，第二次的 `detail` 不得等于第一次的行内容。

## 注释

- 引擎对**存在但无输出**的命令不给任何回执（`bridge_chat_announce`、`ban`、`banid`、`unban`、`banlist_reload`、`sv_cheats` 实测如此）→ "静默"是一等公民，不是错误。
- `console` 的输出可能非常大（实测 `activity_dump` 回 983 行）→ 只保留前 `--wait` 窗口内的行，UI 里截断显示，`--json` 里给行数。

## 实现记录（2026-09-14）

- 已完成：`src/receipt.ts`（纯函数分类）、水位线（`logWatermark`/`readAfter`）、`consoleWithReceipt`、`console --json/--wait`、退出码 0/1/2、面板按 kind 着色。
- 实测证据：`console status` → 成功（`hostname: …`）exit 0；`console say hello` → `Command 'say' doesn't exist…` exit 1；`console sv_addbot` → `usage 'sv_addbot': …` exit 1；`console bridge_chat_announce` → 静默 exit 0；连续两次 `status --json` 各 7 行（水位线不累积）。
- 设计补充：`silent` 定义为"没有可判定的行"，`lines` 仍带回未匹配输出供界面展示。
- 待真人：无。
