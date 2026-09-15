# CONTEXT

r5-server 的领域词汇表与模块地图。文档基建：`AGENTS.md`（约定）、`docs/agents/`（追踪器与标签）、`.scratch/<feature>/`（规格与工单）、本文件（领域语言）。
规格与增强点清单见 `.scratch/fleet-ops/spec.md` 与 `.scratch/fleet-ops/roadmap.md`。

## 这是什么

管理 **r5f-dedi**（基于 Apex Legends S21 的 R5Flowstate 专用服务端改版）的 Windows 工具：版本切换、启动/停止/重启、升级与备份、托管控制台日志、在线玩家与审核、模式与公告。单机部署（腾讯云轻量 2C8G/80G，Windows Server 2022），不引入公网管理端口。

## 领域词汇

| 术语                        | 含义                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **版本目录**                | `r5f-dedi-<版本>/`，一个完整的服务端版本（约 4.16 GB）。同时可存在多个；`state.current` 指向当前生效者                                                        |
| **实例**                    | 一次运行中的服务端进程（`r5apex_ds.exe`），由 `state.runtime` 描述：pid、游戏端口、启动时间、日志、控制通道                                                   |
| **托管控制台**              | 以 `R5F_HOSTED_CONSOLE`/`R5F_CONSOLE_PIPE`/`R5F_CONSOLE_IN`/`R5F_CONSOLE_ROLE` 环境变量启动引擎的模式；引擎的控制台输出经命名管道流出，输入经管道流入         |
| **日志守护（`__logd`）**    | 分离进程：持有引擎的输出/输入管道，把控制台输出追加到日志文件，并把控制口收到的命令写进引擎输入管道。CLI/面板退出后仍存活                                     |
| **控制通道**                | `127.0.0.1:<ctlPort>` + 随机令牌（首行 `AUTH <token>`）。面板/CLI → 守护 → 引擎控制台。**等价 RCON，但不新增公网端口**                                        |
| **回执（receipt）**         | 引擎对命令的回答分类：`success`（明确动作行）/ `unknown`（`Command 'x' doesn't exist`）/ `usage`（参数用法）/ `silent`（命令存在但无输出）。静默 ≠ 成功       |
| **面板（GUI）**             | solid-gpui 原生窗口：首页、服务器列表/实例/实时日志/玩家列表/控制面板、配置档案与启动设置、模式与地图、公告、主机配置、体检、封禁名单、启动引导               |
| **配置档案（profile）**     | 一组命名启动设置的快照；`state.settings` 始终是**生效值**，激活档案＝把它拷进 `settings`。启动对话框默认选 `currentProfile`（上次用的那份）                   |
| **健康（health）**          | 引擎每次运行写 `platform/logs/server/<uuid>/{error,warning,script_warning}.log`，`latest.txt` 指向本次。`error.log` 非空即本次运行有问题                      |
| **日志分片**                | 本工具把每次启动的输出写到 `logs/<版本>-<端口>-<时间>.log`，保留最近 N 份（`settings.logRetention`）；面板「实时日志」页可在分片间回看                        |
| **模式（playlist / mode）** | R5F 的玩法条目，位于 `platform/playlists_r5_patch.txt`；带 `r5f_mode_*` 元数据的构成**模式目录**，按 family 分组（`1v1` / `flowstate` / `mixtape` / `apex`…） |
| **公告表**                  | `platform/datatable/chat_announcements.csv`：轮播（rotate）与进场（welcome）文案，字段 `kind,tag,text,color,sustain,fade,wait`；改动需 changelevel 或重启     |
| **爬虫（bot）**             | 用 `spawnbots <count>` / `sv_addbot <name> <teamid>` 造的假玩家（`uniqueid == "0"`，无地址）；**不可封禁**，只能踢                                            |
| **cfg 同步**                | 启动前把面板设置写回 `autoexec_server.cfg` 等已存在的 cvar 行（保留注释/缩进），避免引擎 cfg **覆盖**面板值                                                   |
| **体检（doctor）**          | 环境检查：防火墙/页面文件/Defender/自启/电源 + 本次运行健康 + 对外上报可见性                                                                                  |

## 模块地图（`src/`）

| 文件                 | 职责                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------ |
| `cli.tsx`            | commander 入口；所有子命令；help 中文化（输出层）                                    |
| `commands.ts`        | 命令实现：启动/停止/重启/升级/设置/玩家/控制台/日志…；构造启动参数；控制通道客户端   |
| `state.ts`           | `r5-server.json` 的读写与容错（`Settings`/`Runtime`/`HistoryEntry`）                 |
| `versions.ts`        | 版本目录发现、备份、切换                                                             |
| `win.ts`             | Windows 探测与动作：进程、端口、防火墙、页面文件、Defender、计划任务、电源           |
| `tap.ts`             | `__logd` 日志守护：管道、日志文件、控制口；日志尾部/增量读（水位线）                 |
| `inspect.ts`         | 面板数据采集：详情、体检、主机能力、（规划中）健康                                   |
| `settings-fields.ts` | **唯一**的设置项声明表：渲染、校验、CLI、面板共用                                    |
| `panel.ts`           | 面板的稳定 API 面：实例快照、日志读取器、动作、档案、清单、公告、健康、封禁台账      |
| `catalog.ts`         | 从版本目录读真实清单：地图名、playlist、模式目录（按家族分组）                       |
| `cfg.ts`             | 读/校验/行级重写引擎 cfg（`shell-quote` 解析）                                       |
| `serverinfo.ts`      | 日志摘要与 status 头部解析                                                           |
| `gui.ts`             | 面板启动器：定位 `r5-server-gui.exe` 并分离启动（`desktop/` 是它加载的 JS/原生宿主） |

界面代码不在 `src/` 下，而在 `desktop/src/`：路由、外壳、会话 store、UI 组件；`desktop/native/` 是原生宿主（Rust）。二者只通过 `src/panel.ts` 与 `src/*.ts` 的逻辑层交互。

## 不变量（改代码时必须保持）

1. **面板值优先于引擎 cfg**：启动前同步已存在的 cvar 行，不新增注入命令。
2. **一次声明，处处一致**：设置项只在 `settings-fields.ts` 声明；CLI 与面板不得各写一套校验。
3. **不虚构引擎能力**：命令/参数必须有实测或 `server.dll` 证据；不支持的能力写进文档并标注未验证。
4. **输出如实**：静默、未验证、猜测都要显式标注。
5. **面板说人话，不泄露标识**：设置项不显示 cvar 名（挂在 `FieldDef.engineName`，只给 CLI）；**UUID 任何位置都不出现全量**（运行编号只显示前 8 位）；pid、端口、日志/名单文件路径属于运维必需信息，允许出现在实例、日志、封禁名单页。日志与 `banlist.json` 原文例外 —— 那是引擎原样输出，排障要看原文。
6. **Windows 脚本 ASCII**：`*.bat`/`*.ps1` 内容保持 ASCII（中文 Windows 的 ANSI 解析会毁 UTF-8 无 BOM）。
7. **无 `any`**：`unknown` + 类型守卫；静态映射用 `Record`；已发布契约用具名类型。
8. **版本目录尽量只读**：只写引擎自写文件与用户明确要编辑的 `chat_announcements.csv`。
9. **不新增公网管理面**：控制通道只回环；远程运维走 SSH/私网隧道（另议）。
10. **输入态吃掉键盘**：只要有文本在收集字符（控制台提示行、对话框、设置项编辑中），可打印字符一律归输入；`q` 退出、`:` 控制台这类**可打印**全局快捷键只在无人输入时生效。新增文本输入面或可打印快捷键时，两处同时改（`routeKey` 的闸 + 本条）。

## 引擎事实（有证据，可引用）

- 启动契约：`-dedicated -port N +hostname … +spire_host_visibility {0|1|2} +sv_onlineAuthMode … +sv_quota_* … [-offline] [+sv_password] [+launchplaylist] [+map]`；环境 `VPROJECT=1`、`FROM_R5F_LAUNCHER=1` 必需。
- 测量：常驻约 3.16 GB、私有提交约 6.46 GB、每实例 ~15–20 线程；换图约 1 核 × 20 s。
- 命令/用法（实测）：`kick "<userid>"`（**不带引号无效**）、`spawnbots <count>`、`sv_addbot <name> <teamid>`、`help <cvarname>`、`convar_findByFlags <string>`、`bridge_setmode <playlist> <map>`、`bridge_chat_announce`、`playlist_override_set <var> <value>`、`banlist_reload`、`changelevel <map>`、`status`。
- 不存在（实测报错）：`say`、`say_team`、`chat_announce`、`mute`、`find`、`cvarlist`、`mp_timelimit`。
- 级别：`Native(E)/(F)` **不是**错误级别（`Native(E)` 里有正常行）；判级别按文件与词。
- 外发：1v1 对战统计 POST 到 `https://play.r5flowstate.org/stats/1v1/ingest`（`fs_stats_url`，置空即关闭）；Spire 匹配/封禁走 `spire_matchmaking_hostname`；`-offline` 关闭匹配。
- Spire 上报（实测日志 + 主服接口）：每 `spire_host_update_interval`（默认 5 s）POST `https://play.r5flowstate.org/spire/hosts/publish`，body = `name` `description` `hidden` `map` `playlist` `ip` `port` `key` `checksum` `version` `numPlayers` `maxPlayers` `timeStamp` `password`。
- 上架条件（实测）：`ip` 正确（`+hostip <公网IP>[:端口]`，引擎在 NAT 主机上自测为 `[::1]:0`，`net_public_adr` 无效）+ **publish 从主机自己的公网 IP 出去**（主机上跑代理/VPN 会改出口 IP，主服照样判不可达；实测加直连规则后立即上架）+ 两道门放行 UDP。主服会 UDP 探测该 `ip:port`（`pktmon` 抓包可见双向包），探测不过即回 `{"success":false,"error":"Unable to communicate, please forward your ports and check if the server is publicly accessible."}` —— 主服文案，引擎原样打印（二进制里搜不到，`rate limit exceeded` 同理）。
- 列表查询（实测）：`POST /spire/hosts`，body `{"version":"R5FlowstateSDK002"}` → `{servers:[{ip,port,name,numPlayers,map,playlist,key,hidden,hasPassword,maxPlayers,description,checksum,allowedMods,requiredMods,modsProfile}],players,capacity}`；空 body 回 `{"error":"Missing required fields.","success":false}`。官方 `r5flowstate.org/host/`：探测不过的服不会出现在列表。相关 cvar：`hostip`、`hostport`（cfg 默认 37015）、`clientport` 37005、`s2sPort` 37016、`spire_showdebuginfo`（1 = 打印请求/回包）、`_sdk_apply_launch_convars`（`+cvar` 启动参数压回 cfg 之上）。
- 日志含运行期密钥（`Installed NetKey: '…'`）→ 分享日志前注意。

## 权威来源

- 设计基线：`.scratch/fleet-ops/spec.md`
- 增强点与状态：`.scratch/fleet-ops/roadmap.md`
- 执行契约：`.scratch/fleet-ops/issues/NN-*.md`
- 用户手册：`README.md`
- 桌面端踩坑记录（solid-gpui）：`docs/solid-gpui-notes.md`
