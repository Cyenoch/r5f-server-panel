# 01 · 机器人管理

- **Status**: `ready-for-agent`
- **Blocked by**: 无
- **归属文件**: `src/commands.ts`、`src/cli.tsx`、`src/tui.tsx`、`src/keys.ts`
- **契约**: `spec.md` §契约 3（机器人）

## Target

让面板与 CLI 能造机器人、列出机器人、清掉机器人。机器人是本批其余功能的**测试台**：没有真人时，它是唯一能产生"玩家列表里有东西"的手段。

非目标：让机器人打游戏（引擎行为，不归我们管）；机器人封禁（实测不可封）。

## 证据（不可再猜）

- `spawnbots <count>` — dll 用法字符串 `Spawn fake players. Usage: spawnbots <count>`；实测 `spawnbots 0` 生成了 `bot0`。
- `sv_addbot <name> <teamid>` — 实测回 `usage 'sv_addbot': name(string) teamid(int)`；带参调用生成 `ProbeBot`。
- `kick "<userid>"` — 实测 `Kicked '1' from server`；**不带引号实测无效**（`kick 1` 无反应），必须带引号。
- 机器人行形态（实测）：`# 1 "bot0" 0 00:00 0 0 active 256000`，其后一行 `  [::]:0`（地址行，机器人为空地址）。
- 机器人 `uniqueid` = `0` → 这是"这是机器人"的判据。

## Change

CLI（`src/cli.tsx`）：

```
bots [list] [--json]                          默认列出机器人（players 过滤 uniqueid === "0"）
bots add [--count N] [--name P] [--team 0|1|2]
      默认 count=1；给了 --name 用 sv_addbot <name> <team>，否则用 spawnbots <count>
bots clear                                    逐个 kick "<userid>"，直到没有机器人或迭代上限（默认 32）
```

- `--json` 输出与 `players --json` 同构（沿用 `PlayerRow`），便于脚本。
- `bots clear` 必须报告清掉了几个；对每个 kick 用回执分类（见 ticket 02）判定是否真被踢掉，最多重试 2 轮。
- 无托管控制台（无 `ctlPort`/`ctlToken`）时：打印与 `players` 一致的引导语并非零退出。

面板（`src/tui.tsx` + `src/keys.ts`，玩家页 `p`）：

- `+` 加 1 个机器人（`bots add`）；`-` 减 1 个（清掉最后一个机器人）；`c` 清空（`bots clear`）。
- 机器人行尾标 `机器人`，与真人区分（用 `uniqueid === "0"`）。
- 玩家页表头统计行改为 `${真人} 人在线 · ${机器人} 个机器人`。
- 动作走既有 `runCommand`（子进程 → 输出进日志区），不要接管屏幕。

## Acceptance

在真机上（托管模式启动的实例）：

1. `bots add --count 2` → `players` 显示 2 个机器人，名字形如 `bot0`/`bot1`。
2. `bots add --name ProbeBot --team 0` → 列表出现 `ProbeBot`。
3. `bots clear` → `players` 里机器人归零，报告清理数量。
4. 面板玩家页按 `+`/`-`/`c` 同上，且动作输出进日志区、页面不消失。
5. 非托管启动时 `bots` 给出明确引导，不是崩溃或静默失败。

## 验证配方

- 真实引擎：`bun run src/cli.tsx start`（托管）→ `bots add --count 2` → `players` 看行 → `bots clear` → `players` 归零。
- 形状断言：机器人行的 `uniqueid` 必须解析为 `"0"`（`status` 解析器已处理两行行结构，别把 `  [::]:0` 当成玩家行）。
- 收尾：验证后必须 `bots clear`，不要让机器人留在用户实例里。

## 注释

- 机器人 `connected` 字段会一直涨（实测 01:10 仍在），不要拿它当"卡住"的判据。
- `spawnbots 0` 的语义未被证实（实测它生成了 1 个机器人）→ **不要**把 `--count 0` 映射成 `spawnbots 0`；`--count 0` 应视为参数错误。
