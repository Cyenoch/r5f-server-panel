# 规格：运营能力增强（机器人 / 控制台回执 / 审核 / 健康与日志 / 公告 / 1v1）

- **状态**：`ready-for-agent`
- **实现状态**：未开始（本文件为设计基线；每个 ticket 的 `Status:` 行是执行状态）
- **追踪器**：本地 markdown（见 `docs/agents/issue-tracker.md`）
- **证据来源**：本规格中所有引擎行为断言都来自以下之一，不含推测
  - 实机探测：托管控制台控制通道（`R5F_CONSOLE_IN`）向正在运行的 r5f-dedi 1.0.13 发命令并读回日志
  - 静态证据：`r5f-dedi-1.0.13/server.dll` 字符串、`platform/playlists_r5_patch.txt`、`platform/datatable/chat_announcements.csv`、`platform/logs/server/**`
  - 每条断言在被引用处标注来源；无法实证的一律标注"未验证"

## Problem Statement

服务器现在是"能跑起来、能看日志、能改启动设置"的程度，但**运营它在跑的时候**没有工具：

1. 想知道谁在线、想踢人只能离开面板去敲命令行（或反过来），而且**没有可信的反馈** —— 面板永远说"已执行"，哪怕引擎回的是 `Command 'x' doesn't exist`。
2. 想填人测试/做活动没有手段；想在没真人的情况下验证踢人、封禁、封禁名单、公告，全都做不到。
3. 封禁只做了"一条命令"的程度：没有时长、没有原因、没有封禁名单视图；引擎其实支持**带原因与到期的封禁**，还支持**通讯封禁（禁言）**，我们一个都没用上。
4. "服务器是不是出问题了"只看得到滚动的标准输出：看不到本次运行自己的 `error.log`，而且**同一个 `版本-端口` 的日志跨启动追加**（实测当前日志里躺着 8 次启动横幅），面板会把上一次运行的内容当成现在。
5. 想让服务器"像个服务器"：有轮播公告、能热换模式/地图。引擎和 R5F 侧其实都已经具备（`chat_announcements.csv`、`bridge_setmode`），我们只是没有把它们接到面板上。
6. 玩法上要**先固定 1v1**：版本自带正式 1v1 模式（`fs_1v1`），但现在只能靠手写启动参数，面板里既看不到模式清单，也没有"立即切换"。

## Solution

把控制通道（已经打通的 `__logd` 控制口 → `R5F_CONSOLE_IN`）从"能发命令"升级成**可信的运营接口**，并在它之上补齐六件事，全部通过面板与 CLI 双入口暴露：

1. **机器人**：`spawnbots <count>` / `sv_addbot <name> <teamid>` 造人，`kick "<userid>"` 清人；面板 `+` / `-` 一键。用于填场，也用于在没有真人时做端到端验证。
2. **回执校验**：每条命令按引擎真实回答分类为 **成功 / 命令不存在 / 用法错误 / 静默**（引擎对部分命令确实不回话 —— 这是事实，不是失败），CLI 退出码与面板文案都据此给出，不再一律"已执行"。
3. **审核**：踢、封禁（时长 + 原因）、解封、禁言；玩家页 `b` 弹确认对话框（时长/原因），新增封禁名单页；封禁名单来自本地 `banlist.json`（存在时）+ `banlist_reload`。
4. **健康与日志**：读 `platform/logs/server/latest.txt` → 本次运行目录的 `error.log`（非空即报红）/`warning.log`/`script_warning.log`；日志按运行分片（`logs/<版本>-<端口>-<runid>.log`），保留最近 N 次，面板标注"本次运行"。
5. **公告**：编辑 `platform/datatable/chat_announcements.csv`（kind/tag/text/color/sustain/fade/wait，文件头自带 schema），用 `bridge_chat_announce` 触发轮播广播；改动在 `changelevel`/重启后生效（引擎自己这么写的）。
6. **1v1**：游戏设置里的"模式"改成**从真实 playlist 目录里选**（按 `r5f_mode_family` 分组，`fs_1v1` 家族优先），固定为 `fs_1v1`；运行中用 `bridge_setmode <playlist> <map>` 一步热切模式+地图。

## User Stories

1. 作为服主，我想在面板里看到当前在线玩家（userid / id64 / ping / 状态 / 名字），以便知道谁在玩。
2. 作为服主，我想在面板里直接踢掉某个玩家，以便处理捣乱的人，不用切到命令行。
3. 作为服主，我想在踢人后立刻看到引擎的回答（`Kicked '1' from server`），以便确认真的执行了。
4. 作为服主，我想封禁某人**指定时长**并写上原因，以便临时处置而不是永久拉黑。
5. 作为服主，我想对某人**禁言**（通讯封禁），以便在不想踢人的情况下止住刷屏。
6. 作为服主，我想按 id64 解封，以便误封后能恢复。
7. 作为服主，我想看到本地封禁名单（类型/到期/原因），以便知道现在封着谁。
8. 作为服主，我想一键加 N 个机器人，以便把服务器填起来做演示或压测。
9. 作为服主，我想一键清掉所有机器人，以便演示结束后恢复干净。
10. 作为服主，我想让机器人出现在玩家列表里并被标记为机器人（uniqueid 为 0），以便不把它们当成真人。
11. 作为服主，我想用机器人验证踢人流程真的通，以便不依赖真人也能回归测试。
12. 作为服主，我想在控制台输入任意引擎命令，以便处理工具没覆盖的情况。
13. 作为服主，我想知道命令到底执行了没有：成功、命令不存在、参数用法错误、还是引擎没回话，以便不被假成功误导。
14. 作为服主，我想在命令失败时从 CLI 拿到非零退出码，以便写脚本时能判断。
15. 作为服主，我想让面板里的动作输出进日志区，而不是接管整个屏幕，以便边看日志边操作。
16. 作为服主，我想看到本次运行**自己的**错误日志（`error.log`）是否非空，以便一眼判断这次运行健不健康。
17. 作为服主，我想让每次启动写各自的日志文件，以便不会被上一次启动的输出误导。
18. 作为服主，我想只保留最近 N 次日志，以便磁盘不被日志吃掉。
19. 作为服主，我想在详情/体检页看到本次运行的时间、版本、端口与日志文件名，以便确认在看对的实例。
20. 作为服主，我想编辑轮播公告文案（内容/颜色/停留时间/间隔），以便做服务器公告。
21. 作为服主，我想让公告对已连接的玩家广播，以便不用重启就通告事情。
22. 作为服主，我想知道公告改动什么时候生效（changelevel 或重启），以便不白等。
23. 作为服主，我想把玩法固定成 1v1，以便服务器就是 1v1 服。
24. 作为服主，我想在设置里从**真实模式清单**里选模式（而不是手打 playlist id），以便不写错。
25. 作为服主，我想看到模式按家族分组（1v1 / mixtape / apex / flowstate），以便快速找到想要的玩法。
26. 作为服主，我想在运行中一步切换模式+地图（`bridge_setmode`），以便不用重启换玩法。
27. 作为服主，我想知道 1v1 的对战数据是否会外发到 `play.r5flowstate.org`，并可关闭，以便掌握我服务器的对外流量。
28. 作为服主，我想让面板诚实标注哪些能力"引擎不支持/未验证"，以便不误信。
29. 作为运维，我想让危险操作（封禁/停止/升级）先确认，以便不误操作。
30. 作为运维，我想让所有页面遵守同一套按键语义（Esc 返回、r 刷新、↑↓ 选择），以便不用记两套。
31. 作为运维，我想在窄终端下仍然能读（表格自动丢列），以便 SSH 到别的机器也能用。
32. 作为运维，我想让面板长时间挂着不烧 CPU（按需采集），以便在服务器上常开。

## Implementation Decisions

### 契约 1：控制通道（已存在，不改语义）

面板/CLI → `127.0.0.1:<runtime.ctlPort>`（首行 `AUTH <runtime.ctlToken>`）→ `__logd` → `R5F_CONSOLE_IN` 管道 → 引擎控制台；引擎输出经 `R5F_CONSOLE_PIPE` 回到 `logs/<...>.log`。控制口与令牌每次启动随 `runtime` 写入 `r5-server.json`。

### 契约 2：命令回执分类（新）

引擎对命令有三种可观察反应，实测：

| 类型      | 触发示例                                                                                                              | 引擎输出                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `unknown` | `echo-test`、`say hello`、`chat_announce`、`mute`、`find chat`、`cvarlist`                                            | `Command 'x' doesn't exist; request 'x' ignored`                                                                         |
| `usage`   | `sv_addbot`、`playlist_override_set`、`help`                                                                          | `usage 'sv_addbot': name(string) teamid(int)` / `usage: playlist_override_set <var> <value>` / `Usage:  help <cvarname>` |
| `success` | `kick "1"`                                                                                                            | `Kicked '1' from server`（明确动作回执）                                                                                 |
| `silent`  | `ban "1"`、`banid 60 1`、`unban "0"`、`banlist_reload`、`sv_cheats`、`bridge_chat_announce`、`playlist_override_list` | 无任何输出（命令存在）                                                                                                   |

决策：

- 分类实现为**纯函数**：输入=发送前后的日志新增行，输出 `{kind, detail}`；不猜测、不把静默当成功。
- 取数用**水位线**：发送前记录日志文件长度，发送后只读新增字节，避免匹配到上一次运行/上一条命令的输出。
- 引擎对 `bridge_chat_announce` 无输出但命令存在（未知命令必然报错，这是判据）→ 归入 `silent` 并在 UI 写"已广播（引擎无回执，效果需真人在场确认）"。
- CLI 退出码：`0` = `success`/`silent`，`1` = `unknown`/`usage`，`2` = 无托管控制台（无 `ctlPort`/令牌）。

### 契约 3：机器人

- 造：`spawnbots <count>`（用法字符串实证：`Spawn fake players. Usage: spawnbots <count>`，实测 `spawnbots 0` 生成了名为 `bot0` 的机器人）与 `sv_addbot <name> <teamid>`（用法字符串实证，实测生成 `ProbeBot`）。
- 清：`kick "<userid>"`（实测 `Kicked '1' from server`；**不带引号无效**，实测 `kick 1` 无反应）。
- 识别：机器人 `uniqueid` 为 `0`、无地址（`status` 地址行为 `[::]:0`），面板标 `机器人`。
- 机器人**不可封禁**（实测 `ban "1"`/`banid 60 1` 对机器人无效果）→ 封禁验证必须用真人，见 Testing Decisions。

### 契约 4：审核

- 踢：`kick "<userid|id64>"`。
- 封禁：`ban "<target>"`；时长与原因按引擎的封禁模型（`banType`/`banExpires`/原因字符串来自连接期提示 `You have an active %s communications ban. Reason: %s ... Expiry: %s`）。**具体参数形式未经实机验证**（无真人客户端；机器人不可封禁）→ 实现按命令层落地，面板/CLI 必须显示引擎回执原文，并明确标注"未验证"。
- 禁言：引擎有通讯封禁概念（`Communication Banned` / `sv_commsBansAreGameBans` / `sv_applyGlobalCommsBans`），但**没有 `mute` 命令**（实测不存在）→ 只能走封禁系统的类型参数；本批实现为"发送带类型的封禁命令 + 显示回执"，不虚构命令名。
- 封禁名单：本地 `banlist.json`（引擎首次真正封禁时创建；实测至今未出现该文件）+ `banlist_reload` 热载。名单页在文件不存在时如实说明。

### 契约 5：健康与日志分片

- 每次启动一个日志文件：`logs/<版本>-<端口>-<YYYYMMDD-HHMMSS>.log`；`runtime.logFile` 指向本次；保留最近 10 个（可用设置调整），更旧的删除。
- 健康数据源：`platform/logs/server/latest.txt` → 指向本次运行目录 `<uuid>/`，读 `error.log`（**非空即问题**；健康运行实测为空）、`warning.log`（启动诊断噪音：`[DETOUR]`/`[FIRE-CLOCK]`/`[ZIP-ATTACH]`，不作为错误）、`script_warning.log`。
- 严重度判定**按文件与词**（`error`/`fail`/`Warning`/`Minimum-disk`），**不按** `Native(E)/(F)` 前缀 —— 实测 `Native(E)` 里是 `Loading level`、`Installed NetKey` 这类正常行，前缀不代表级别。

### 契约 6：公告

- 文案表：`platform/datatable/chat_announcements.csv`，表头注释即 schema：`kind,tag,text,color,sustain,fade,wait`；`kind` ∈ {rotate, welcome}；`text` ≤ 64 字符；`color` ∈ {空/white, red, gold, green, cyan, rainbow, "255 80 80"}；`sustain` 默认 8、`fade` 默认 2、`wait` 默认 60（rotate）/10（welcome）。
- 解析/写入用 **`csv-parse` + `csv-stringify`**（活跃维护；文件含引号单元格与 `#` 注释块，手搓必错）。写入只重写数据行，**保留原注释块与表头**。
- 触发：`bridge_chat_announce`（描述字符串实证："Broadcast the rotating server chat announcements."）。生效时机：引擎文件头自述"Edit this file, then changelevel (or restart the dedi)"。
- 不做 `say`/`chat_announce`：实测不存在，不虚构。

### 契约 7：1v1

- 模式目录来自 `platform/playlists_r5_patch.txt`（`r5f_mode_group/family/family_title/family_order/mode/mode_order/mode_title/mode_map/mode_blurb`）。1v1 家族实测存在：`fs_1v1`（`name "FS 1v1"`、`inherit survival_dev`、`fs_1v1_use_realms 1`、`fs_1v1_locked_set "blue"`、11 个 `fs_1v1_rotate_mp_rr_*`、独立 `gamemodes { fs_1v1 { maps { ... } } }`）与 `fs_lgduels_1v1`（R99 上膛决斗）。
- 固定 1v1：设置项 `playlist = fs_1v1` → 启动参数 `+launchplaylist fs_1v1`（现有机制），地图取该模式的地图清单。
- 热切：`bridge_setmode <playlist> <map>`（描述实证："Apply a playlist and change level in one step. Usage: bridge_setmode <playlist> <map>"）。
- 对外上报：1v1 对战统计会 POST 到 `https://play.r5flowstate.org/stats/1v1/ingest`（cvar `fs_stats_url`，置空即关闭；`fs_stats_host_key` 为校验键；`fs_http_timeout`）。**不改默认**，只在体检/设置里显示当前是否外发，并提供关闭项。

### 面板与 CLI 表面（冻结，供并行实现）

CLI（新增/变更）：

```
bots [list] [--json]                 列出机器人（= players 过滤 uniqueid=0）
bots add [--count N] [--name P] [--team 0|1|2]
bots clear                           逐个 kick 所有机器人
console <command...> [--json]        回执分类；退出码 0/1/2
ban <target> [--minutes N] [--reason S]
mute <target> [--minutes N] [--reason S]
banlist [--reload] [--json]
announce                             触发轮播广播（bridge_chat_announce）
announcements list|add|remove        编辑 chat_announcements.csv
mode list [--json]                   按 family 分组的模式清单
mode set <playlist> [map]            bridge_setmode（运行中生效）
health [--json]                      latest.txt → 本次运行 error/warning/script_warning
logs [--all] [--run <id>]            运行分片列表/读取
```

TUI：

- 玩家页 `p`：`↑↓` 选择、`k` 踢、`b` 封禁（对话框：时长/原因）、`m` 禁言（对话框）、`u` 解封、`+`/`-` 加/减机器人、`c` 清空机器人、`r` 刷新、`:` 控制台、`Esc` 返回。机器人行标 `机器人`。
- 封禁名单页 `B`：本地 `banlist.json` 内容 + `banlist_reload`。
- 游戏设置页 `g`：模式项改为**目录选择器**（按 family 分组、显示 `r5f_mode_title`），选中 `fs_1v1` 时地图清单来自该模式；新增"立即切换（bridge_setmode）"动作。
- 体检页 `d`：新增本次运行健康块（`error.log` 是否为空、最后修改时间、warning 计数）+ 对外上报状态。
- 所有危险操作（封禁/禁言/停止/升级）走确认对话框；输出仍进日志区。

### 状态与文件

- `r5-server.json`：`runtime` 增加 `logFile`（已有）语义收紧为"本次运行的日志文件"；`state` 增加 `logRetention`（默认 10）、`announcementsPath`（默认版本目录内）。
- 版本目录**只读**：除 `chat_announcements.csv`（用户明确要编辑的公告文案）与引擎自写的日志/`banlist.json` 外，工具不写版本目录（与既有约定一致：`autoexec_server.cfg` 仅在面板值需要覆盖时行级重写）。

## Testing Decisions

- **缝（seam）**：全部功能只经由**两条既有缝**验证，不新增测试基建：
  1. 控制通道（`console`/`bots`/`mode set`/`announce` 发出的命令与回读的引擎回答）；
  2. 文件与日志（`chat_announcements.csv`、`logs/*.log`、`platform/logs/server/latest.txt`、`banlist.json`）。
- **什么算好测试**：只测外部可观察行为 —— 引擎回执文本、日志文件新增行、CLI 退出码、CSV 往返后的字节一致性、PTY 里的可见输出。不测内部函数调用、不测"字段被赋值"。
- **纯函数**（回执分类、CSV 表解析、status 块解析、健康聚合、模式目录分组）用一次性脚本对着**真实文件与真实回执样本**跑断言，跑完删除（沿用本仓库既有做法：不引入测试框架；`bunx tsc -p tsconfig.json` 是常驻闸门）。
- **端到端**：机器人（`bots add` → `players` 见 bot → `bots clear` → 归零）、回执（三条真实路径：成功/不存在/静默）、公告（改 CSV → 字节往返一致 → 触发广播）、模式（`mode set fs_1v1 <map>` → 回执 → `status` 头部 hostname 不变、无崩溃）、健康（读真实 `latest.txt`）。
- **真人依赖**：封禁/禁言的最终效果、公告的可见性、1v1 实际对局体验**无法用机器人验证**（机器人不可封禁；机器人不显示聊天）。这些在 ticket 里标 `needs-info`，实现以"命令 + 回执 + 文档"为完成标准，并把验证步骤写给服主。
- **面板**：PTY 跑真源（`bun run src/cli.tsx`）逐页检查；最终用 exe 复验一次。

## Out of Scope

- 逆引擎自定义 RCON 协议、暴露公网 RCON/管理端口（安全面不划算；控制台通道已等价）。
- `say` / `chat_announce` / `mute` 等实测不存在的命令（不虚构）。
- 内网穿透、远程面板、Web UI、多实例编排、告警外推、崩溃自动拉起、玩家统计入库 —— 见 `roadmap.md`，属后续批次。
- 引擎本体的 `bridge_headglitch_*` 等专业调参项、`activity_dump` 类大输出调试命令。
- 改动任何"引擎默认"行为（如默认关闭 1v1 数据外发）；只提供开关与可见性。

## Further Notes

- **`Native(E)/(F)` 不是级别**：实测 `Native(E)` 包含 `CHostState::State_NewGame: Loading level` 等正常行；健康判定按文件与词。
- **引擎对未知命令必然报错**（`Command 'x' doesn't exist`）——这既是回执分类的依据，也是"某命令是否存在"的判定方法（`bridge_chat_announce` 即由此确认存在）。
- **`help <cvarname>` 与 `convar_findByFlags <string>` 存在**（实测 `Usage: help <cvarname>`）；因此"设置项的 cvar 名/说明/默认值"有机会改为**引擎权威来源**，替代现在手写的 hint。列入 roadmap 后续批次。
- **`[ADMIN-CMD] slot=%i id64=%llu '%s'` 审计行**与 `[BRIDGE-SCMD] drop ... (cheat|exec quota|net-key|devonly ConCommand)` 过滤日志存在，可作为"谁用了管理员命令"的审计来源（后续）。
- **日志里会出现 `Installed NetKey: '...'`**（实测启动时 1 次、运行中 809s 时又出现 1 次，原因未知）→ 日志分享前注意其中含运行期密钥；列入 roadmap 的"日志治理"。
- **`sv_quota_scriptExecsPerSecond`** 是引擎真实 cvar 名（`server.dll` 符号表），现有实现写的是这个名字（正确）；`autoexec_server_dev.cfg` 里的是 `sv_quota_stringCmdsPerSecond "256"`。
- 全部 six 项的证据、判定与状态见 `roadmap.md`；逐项执行契约见 `issues/NN-*.md`。
