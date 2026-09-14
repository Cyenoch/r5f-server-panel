# 03 · 审核能力与封禁名单

- **Status**: `ready-for-human`（实现已完成；剩余步骤需要人或真人玩家在场）
- **Blocked by**: 02（回执分类：审核动作必须报告引擎真实回答）
- **归属文件**: `src/commands.ts`、`src/cli.tsx`、`src/keys.ts`、`src/tui.tsx`、`src/ui.ts`
- **契约**: `spec.md` §契约 4（审核）

## Target

把"踢人一条命令"补成一套可用的处置手段，并且**只做引擎真正支持的部分**：踢（已验证）、封（命令存在、无回执）、解封、封禁名单（本地文件 + 热载）。时长与原因做不了 —— 见下面的证据结论，这一条要如实告诉服主，不能假装支持。

## 证据与结论（决定"做什么"和"不做什么"）

| 事实                                                                                                                          | 来源                                                                 | 后果                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `kick "<userid>"` 生效并回 `Kicked '1' from server`                                                                           | 实测                                                                 | 踢人保持现状（CLI 已带引号）                                                                                    |
| `ban "<target>"` / `banid` / `unban` 命令存在但**无任何回执**                                                                 | 实测（机器人不可封禁，`ban "99"`、`banid 60 1`、`unban "0"` 全静默） | 只能"发送 + 如实报告无回执"，**不能**验证结果                                                                   |
| 封禁带类型/到期/原因：`banType`、`banExpires`、连接期提示 `You have an active %s communications ban. Reason: %s … Expiry: %s` | dll                                                                  | 这些字段属于 **Spire 主服务** 的封禁模型（`/spire/moderation/one`、`/spire/moderation/bulk`、`bannedPlayers`…） |
| `mute` **命令不存在**（实测报错）                                                                                             | 实测                                                                 | 不实现 `mute`；禁言是封禁类型参数 / Spire 侧能力                                                                |
| `banlist.json` 至今**未被创建**（实测无文件）                                                                                 | 实测                                                                 | 名单页做成"存在则显示，不存在则说明为什么"                                                                      |
| `banlist_reload` 存在，热载封禁名单                                                                                           | dll + 实测（静默）                                                   | 提供 `--reload`                                                                                                 |
| `sv_globalBanlist`（0–3）、`sv_banlistRefreshRate`、`BanSystem_ConvertAddress`、`Server_Script_BanPlayerById                  | ByName`                                                              | dll                                                                                                             | 后续可探索：全局封禁同步等级、地址封禁、脚本侧封禁 |

结论：**本批做"发送 + 回执 + 名单 + 拒绝未证实参数"**；时长/原因的本地命令形式未经实证，宁可明确拒绝也不发一个猜的参数。

## Change

CLI（`src/cli.tsx`）：

```
kick <userid|id64>                      不变（已带引号）
ban <userid|id64>                       发 ban "<target>"；回执静默 → "已发送（引擎无回执）"
unban <id64>                            发 unban "<id64>"
banlist [--reload] [--json]             --reload 先发 banlist_reload，再读本地 banlist.json（存在时）
```

- `ban --minutes` / `--reason`：**不实现**。给出明确错误（退出码 1），内容包含：封禁的时长/原因属于 Spire 封禁模型（`banType`/`banExpires`），本地控制台命令未提供这些参数（未经实证）；想自行试验请用 `console ban "<id>" <minutes> "<reason>"`，并提示该形式**未经验证**。
- `banlist` 查找顺序（第一个存在者）：版本目录根、`platform/`、`platform/cfg/`。解析 JSON；字段按需展示（`type`/`expires`/`reason`/`id64`，名字因引擎而异 → 原样呈现键值，不硬编码 schema）。空/缺文件时输出解释而非"空列表"。

面板（`src/tui.tsx` + `src/keys.ts`）：

- 玩家页 `b` → **确认对话框**（居中，沿用设置页对话框实现）：显示目标名字/userid/id64，以及一行如实说明"本地封禁命令；引擎无回执，时长/原因不可用（属 Spire 侧）"；回车执行，Esc 取消。
- `u` → 解封（id64），同样确认。
- 新增 **封禁名单页**（`B`）：`banlist` 内容；`r` 刷新（= `--reload`）；无文件时显示原因说明；`Esc` 返回。
- 踢人 `k` 保持即时执行（低风险、可逆）。

## Acceptance

1. `ban 1` → 退出码 0，文案"已发送（引擎无回执）"（机器人不可封禁，这正是预期）。
2. `ban 1 --minutes 30` → 退出码 1，说明为什么不做，且**没有**向引擎发送任何带猜测参数的命令（用日志水位校验：发送前后无新增行）。
3. `banlist` 无文件 → 解释文案；手工放一个 `banlist.json` 后 `--json` 能读出来（键值原样）。
4. `banlist --reload` → 发送 `banlist_reload` 并报告回执。
5. 面板 `b` 弹确认对话框，Esc 取消后页面状态不变；回车后动作输出进日志区。
6. `B` 页在无文件/有文件两种情况下都正确渲染。

## 验证配方

- 真机：托管启动 → `ban 1`（机器人 target）→ 看回执与退出码 → `banlist`。
- 名单文件：构造一个含中文与未知键的 `banlist.json` 做解析断言（脚本一次性，跑完删除；**不要**把测试文件留在版本目录）。
- 负向：`ban 1 --minutes 30` 的前后日志水位必须相等（证明我们没发猜的命令）。

## 注释

- 真人端到端（真的封掉一个真人、看他被拒绝进入）在本机做不到 → 该验证步骤写进 README 交给服主，并在 `roadmap.md` 保持 `需验证`。
- `unban` 需要 id64；面板从玩家行取（真人行的第 3 列）。

## 实现记录（2026-09-14）

- 已完成：`ban`/`unban`（回执如实）、`banlist [--reload] [--json]`（三处查找顺序 + 键值原样 + 无文件解释）、面板玩家页 `b`/`u` 确认对话框、封禁名单页（`B`）。
- 实测证据：`ban 1` → "已发送（引擎无回执）" exit 0；`ban --minutes 30` → exit 1 且**零字节发送**（水位线 2335→2335 相等）；合成 `banlist.json`（对象/数组/中文/坏 JSON）解析与退出码正确，测试文件已删。
- 仍未验证（需真人）：封禁/禁言的实际生效；时长与原因属 Spire 侧模型（`banType`/`banExpires`）。本机 `banlist.json` 至今未被引擎创建。
- 不做：`mute`（命令不存在）、`ban --minutes/--reason`（参数形式未实证，明确拒绝）。
