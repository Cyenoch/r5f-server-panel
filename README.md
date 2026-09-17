# r5-server —— R5Flowstate 服务器管理面板

管理 **R5Flowstate 专用服务端（`r5f-dedi-*`）** 的 Windows 原生面板与命令行工具：版本下载、持久实例、玩法模板、多实例运行、控制台、玩家管理与真实观测数据。

- **面向谁**：自建 R5Flowstate 专用服的服主与运维。单机部署，不需要公网管理面。
- **不做什么**：不是游戏本体；安装包不捆绑游戏内容，可在版本库从官方地址下载或使用本地完整版本。不新增公网管理端口。

> 与 Respawn Entertainment / Electronic Arts / R5Flowstate 官方无隶属关系，为第三方运维工具。

## 设计取舍

| 取舍                 | 做法                                                                               | 为什么                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **不开管理端口**     | 控制通道只监听 `127.0.0.1` 的临时端口 + 每次启动随机令牌                           | 本构建的 RCON 是自定义协议（AES-128-GCM），现成客户端连不上，且 `rcon_server.cfg` 启动时会把 `sv_rcon_password` 覆盖成空。改用引擎自带的托管控制台输入管道，等价能力，零新增 DDoS 面 |
| **面板值优先**       | 启动前把面板设置写回**已存在**的 cvar 行（`autoexec_server.cfg` 等）               | 引擎在启动参数*之后*执行 cfg，否则 cfg 会静默覆盖你刚设的值                                                                                                                          |
| **共享版本只读**     | 每个实例使用 `instances/<id>/engine` 私有工作副本                                  | 配置、公告、封禁与日志互不污染；版本升级不会改动其他实例                                                                                                                             |
| **静默 ≠ 成功**      | 引擎回执分 `success` / `unknown` / `usage` / `silent` 四类，逐类如实汇报           | 托管控制台没有 RCON 状态码，唯一可信信号是引擎自己的输出；"没回话"不能算"执行成功"                                                                                                   |
| **不虚构引擎能力**   | 命令/参数必须有实测或 `server.dll` 证据；不支持的写进文档并标注                    | 见下方[已知边界](#已知边界)                                                                                                                                                          |
| **依赖等满 24 小时** | `bunfig.toml` 里 `install.minimumReleaseAge = 86400`，安装时跳过发布不满一天的版本 | 投毒包一般在发布后几小时内被发现并撤下；面板能起进程、能提权，装错一次等于交出宿主机                                                                                                 |

## 环境要求

| 项         | 要求                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| 系统       | Windows x64（Windows Server 2022 验证过；进程/端口/防火墙/提权全部走 PowerShell 与 Win32 API，无 Linux 路径） |
| 服务端内容 | 一个 `r5f-dedi-x.y.z` 目录，根目录须同时含 `r5apex_ds.exe` + `server.dll` + `loader.dll`                      |
| 内存       | 每实例预留 **3.2 GB 工作集 / 6.5 GB 提交**；8 GB 机器必须设固定页面文件（`setup` 会做）                       |
| 运行面板   | CLI 为 Bun 编译的单文件；图形面板还需同级原生宿主、JS 包，以及同级或 PATH 中的 Bun                            |
| 从源码构建 | Bun、Git 子模块、根目录指定的 Rust 工具链；Windows 需 MSVC C++ Build Tools 与 Windows SDK（见[开发](#开发)）  |

## 快速开始

```powershell
# 1. 把解压好的服务端目录放进面板所在目录（名字随意，三件套齐全即可）
#    D:\r5-server\r5f-dedi-1.0.13\{r5apex_ds.exe, server.dll, loader.dll, ...}

# 2. 主机一次性配置：防火墙 / 页面文件 / Defender 排除 / 登录自启（会弹 UAC）
.\r5-server.exe setup --ports 37015 --dry-run    # 先看要改什么
.\r5-server.exe setup --ports 37015

# 3. 创建并选择持久实例，再启动
.\r5-server.exe instance create "我的服务器" r5f-dedi-1.0.13
.\r5-server.exe instance select "我的服务器"
.\r5-server.exe start

# 4. 打开面板
.\r5-server.exe
```

启动后 10–30 秒内 `status` 会显示运行中；玩家用 R5Flowstate 启动器在服务器列表里找到它（`visibility=2`），或 `connect <公网IP>:37015`。

> **云服务器两道门都要开**：控制台的安全组/防火墙放行同样的 **UDP** 端口，与 Windows 防火墙是两套独立规则，只开一边外网连不上。

## 图形面板

不带子命令运行 `r5-server` 即打开图形面板（等价写法 `r5-server gui`）。面板是一个**原生窗口**：界面用 [solid-gpui](https://github.com/Cyenoch/solid-gpui) 写，逻辑跑在同一份 TypeScript 里（`src/` 下的模块 CLI 与面板共用，没有第二套实现）。

全局导航分成：**总览、服务器实例、运行中、游戏模式模板、服务端版本、主机环境、开服检查清单**。

实例工作区包含：**概览、控制台、玩家、设置、公告、健康、封禁**。启动、停止、重启只作用于当前实例；复制实例重新分配端口，运行中实例拒绝删除。

推荐流程：

1. 在版本库检查 `https://r5flowstate.org/dedi`，从实际返回文件名识别版本并安装；已有版本不会被覆盖。
2. 创建玩法模板，选择发行版提供的模式、地图与已验证参数。
3. 创建实例，绑定版本、端口、可见性与模板；需要公网时再配置公网地址、Windows 防火墙和云安全组。
4. 启动实例，在其工作区查看日志、管理玩家和观测数据。

**保存不等于生效**。运行中有两个不同动作：

- **应用运行参数**：不主动换图。每轮读取的变量在后续轮次生效；1v1 单局时长在关卡初始化缓存，仍需换图。
- **重新加载玩法**：应用模板并明确换模式/地图，中断当前对局。只有引擎回执或参数回读确认后才标记已应用。

启动时模板写入实例私有 playlist；删除的覆盖值恢复发行版基线。模板编辑不会自动修改正在运行的进程。

总览与实例曲线使用本机实际采样：每 10 秒采集，保留 24 小时，可看 1/6/24 小时。CPU 的 100% 表示一个逻辑核；未知值不当作零，面板关闭期间不生成采样。模拟环境数据会明确标识。

### 面板的运行方式

`r5-server.exe` 是 CLI 与面板启动器（编译产物，无运行时依赖）；真正的界面是一个原生宿主 `r5-server-gui.exe` 加它的 Bun 子进程 `r5-server-gui.js`。三者必须在同一目录，Bun 可放在同级或加入 PATH。源码构建时在项目根运行 `bun run build` 与 `bun run gui:stage` 摆好。发布 CLI 总是启动 production 宿主，不依赖构建机上的 Vite 或源码路径。

宿主进程被强杀（任务管理器、崩溃）时，上游默认 `StdioTransport` 会随宿主管道的 EOF 或读错误退出渲染器，不再由应用定时探测父进程。面板启动的游戏服务器与日志守护是 `detached` 进程，**关掉面板不会带走正在跑的服务器**。

源码开发直接在根目录运行 `bun run dev` / `bun run gui`，模拟后端用 `bun run gui:dev`。`bun run cli` 或 `bun run dev:cli` 不带子命令时也会启动 Vite；带子命令时运行 CLI。程序目录独立于 `R5_SERVER_ROOT` 和 `.dev/r5f` 数据目录，不会到数据目录或 Bun 安装目录寻找面板。

## 命令参考

实例操作先用 `instance select <名称或 ID>` 选择目标；选中项不是全局唯一运行中的服务端。

### 版本与实例

| 命令            | 说明                                                 | 选项                                                                 |
| --------------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| `list`          | 列出根目录下的可用版本                               | `--fast` 跳过体积统计                                                |
| `use [dir]`     | 修改所选实例的期望版本，不切换正在运行的进程         | —                                                                    |
| `start`         | 启动所选实例，已运行时拒绝重复启动（包括 `--force`） | 启动覆盖只影响本次运行                                               |
| `stop`          | 停止所选实例及其日志守护                             | `--all` 仅停止有记录的实例，不扫描并误杀其他服务端                   |
| `restart`       | 按已保存配置重启所选实例                             | —                                                                    |
| `status`        | 人数/地图/CPU/帧耗时/内存/端口/日志/自启             | `--watch` 每 3 秒刷新                                                |
| `upgrade [dir]` | 备份旧配置 → 迁移 → 切换                             | `--to <dir>` `--carry none\|config\|all`（默认 `config`）`-y, --yes` |

### 日志与健康

| 命令     | 说明                                                                       | 选项                                                                                |
| -------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `logs`   | 看日志；默认本次运行                                                       | `-f, --follow` `--lines <n>`（默认 40）`--all` 列出全部分片 `--run <id>` 读指定分片 |
| `health` | 本次运行健康：`latest.txt` → `error` / `warning` / `script_warning`        | `--json`                                                                            |
| `doctor` | 环境体检（防火墙/页面文件/Defender/自启/电源 + 本次运行健康 + 对外可见性） | —                                                                                   |

### 玩家、机器人与审核

| 命令                      | 说明                                                      | 选项                                                    |
| ------------------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| `players`                 | 在线玩家（解析引擎 `status`）                             | `--json`                                                |
| `console <command...>`    | 在运行中的实例上执行控制台命令，并报告引擎回执            | `--json` `--wait <ms>`（默认 1200）                     |
| `bots [list\|add\|clear]` | 机器人：列出 / 添加（`spawnbots`、`sv_addbot`）/ 全部踢掉 | `--json` `--count <n>` `--name <name>` `--team 0\|1\|2` |
| `kick <target>`           | 踢出（userid 或 id64）                                    | —                                                       |
| `ban <target>`            | 封禁（userid 或 id64；引擎无回执，结果无法确认）          | `--minutes` / `--reason` **不支持**，给了直接退出 1     |
| `unban <target>`          | 解封（id64）                                              | —                                                       |
| `banlist`                 | 本地 `banlist.json`（文件由引擎在首次真正写入封禁后生成） | `--reload` 先发 `banlist_reload` `--json`               |

### 模式与公告

| 命令                                        | 说明                                                                                   | 选项                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `mode [list\|set] [playlist] [map]`         | 模式目录（按家族分组）与运行中热切（`bridge_setmode`；`set` 省略地图时用模式默认地图） | `--json`                                                                                   |
| `announce`                                  | 触发一次轮播公告广播（`bridge_chat_announce`）                                         | `--json`                                                                                   |
| `announcements [list\|add\|remove] [index]` | 编辑 `platform/datatable/chat_announcements.csv`                                       | `--json` `--text` `--kind rotate\|welcome` `--tag` `--color` `--sustain` `--fade` `--wait` |

### 主机与设置

| 命令                                       | 说明                                                   | 选项                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup`                                    | 防火墙 / 页面文件 / Defender / 自启 / 电源（自动提权） | `--ports <list>` `--dry-run` `--no-task` `--no-firewall` `--no-power` `--no-defender` `--no-pagefile` `--task-name` `--page-init <mb>` `--page-max <mb>` |
| `autostart [enable\|disable\|status\|run]` | 开机自启计划任务（默认动作 `status`）                  | `--trigger logon\|startup` `--task-name` `--args` `--dry-run`                                                                                            |
| `settings`                                 | 查看或修改持久启动设置（不带参数即打印表格）           | `--port` `--map` `--playlist` `--hostname` `--password` `--visibility` `--auth` `--quota-string` `--quota-script` `--extra`                              |
| `gui`                                      | 打开桌面面板（不带子命令运行也是它）                   | `--production`（读构建好的 JS 包）                                                                                                                       |

**退出码**：`console` / `kick` / `ban` / `unban` / `bots add` → `0` 成功或静默、`1` 命令不存在或用错、`2` 没有控制通道（没启用托管控制台）；`setup` / `autostart` → `1223` 表示用户拒绝了 UAC。

#### 1v1 模式（当前默认）

本机默认已固定成 1v1：`playlist = fs_1v1`、`map = mp_rr_arena_habitat`（都在 `r5-server.json` 里，面板"游戏设置"可改）。

- `fs_1v1` 是版本自带的 R5F 模式（`platform/playlists_r5_patch.txt`），家族 `1v1`，声明了 11 张可轮换地图（`fs_1v1_rotate_mp_rr_*`）。
- 运行中换模式/地图无需重启进程，但会中断对局：CLI 用 `mode set fs_1v1 mp_rr_arena_phase_runner`；面板在实例工作区明确选择「重新加载玩法」。
- 模式自己的参数（装备套装 `fs_1v1_locked_set`、自定义武器 `custom_1v1_weapons_*`、轮换图开关）写在该模式的 `vars` 块里，改完 `changelevel` 或重启生效。
- 同家族还有 `fs_lgduels_1v1`（R99 上膛决斗）。
- 1v1 对战统计默认会 POST 到 `play.r5flowstate.org`；不想外发就把"1v1 数据上报"设为"关闭上报"（启动参数追加 `+fs_stats_url ""`）。

## 配置

配置保存在根目录的 `r5-server.json`，包含 `instances`、`templates`、`selectedInstanceId` 与 `history`。实例保存名称、版本、设置、模板绑定和运行记录；运行记录中的 `applied` 是启动快照，`live` 与 `overrides` 是引擎已确认的运行期状态。

旧的单实例/配置档案自动迁移为持久实例；保留原运行记录。写入先取得 SQLite 跨进程写锁（`.state-lock.sqlite`），重读并只合并本次变更，再原子替换 JSON，避免 CLI 与面板互相覆盖。

共享安装目录不写运行数据。每个实例的工作副本约需一个完整发行版的空间（官方 1.0.13 展开约 4.47 GB）；支持 reflink 的文件系统可减少物理占用，Windows 通常是真实复制。版本切换先复制到暂存目录，成功后交换，保留公告和封禁文件。

设置项以 `src/settings-fields.ts` 为唯一声明与校验来源，下面是主要字段：

| 字段           | 类型            | 默认                  | 说明                                                                           |
| -------------- | --------------- | --------------------- | ------------------------------------------------------------------------------ |
| `hostname`     | string          | `R5F Server`          | 服务器名，1–60 字符，显示在服务器列表与控制台标题                              |
| `map`          | string          | `mp_rr_arena_habitat` | 启动地图，候选来自当前版本真实清单                                             |
| `playlist`     | string          | `fs_1v1`              | 启动即进入的模式；留空 = 由玩家选。取自 R5F 模式目录（按家族分组）             |
| `visibility`   | 0/1/2           | `0`                   | `spire_host_visibility`：0 离线直连 / 1 隐藏 / 2 公开列表                      |
| `authMode`     | 0/1/2           | `0`                   | `sv_onlineAuthMode` 在线认证强度，公开服建议开启                               |
| `password`     | string          | 空                    | `sv_password`，客户端要一致；**明文存放**                                      |
| `port`         | number          | `37015`               | 游戏 UDP 端口，一个实例一个                                                    |
| `quotaString`  | number          | `256`                 | `sv_quota_stringCmdsPerSecond`                                                 |
| `quotaScript`  | number          | `128`                 | `sv_quota_scriptExecsPerSecond`                                                |
| `statsUpload`  | `default`/`off` | `default`             | 1v1 对战统计是否 POST 到 `play.r5flowstate.org`；`off` 追加 `+fs_stats_url ""` |
| `logRetention` | number          | `10`                  | 保留最近几次运行的日志分片（本机设置，不传给引擎）                             |
| `extra`        | string          | 空                    | 原样追加到启动命令行，用于传本表没有的参数                                     |

`statsUpload` 与 `logRetention` 目前**只能在面板的游戏设置页改**（`settings` 命令没有对应开关）。

## 工作原理

### 目录布局

```
r5-server\
├─ r5-server.exe            面板本体（Bun 编译单文件）
├─ r5-server.json           状态：当前版本 / 启动设置 / 运行中实例 / 操作历史
├─ start_dedi.bat           双击入口：等价于直接运行 r5-server.exe
├─ logs\                    每次运行一份日志分片 + 日志守护 pid 文件
├─ backups\                 upgrade 前的运维文件备份（按时间戳）
└─ r5f-dedi-1.0.13\         一个版本一个目录，三件套齐全才会被识别
   ├─ r5apex_ds.exe  server.dll  loader.dll
   └─ platform\ paks\ vpk\ maps\ mods\ cfg\ audio\ r2\ ...
```

根目录取自 `r5-server.exe` 所在目录（源码方式运行时取仓库根）。版本目录名随便叫，**只要三件套齐全**就会被 `list` 收录；名字里带 `x.y.z` 时按版本号倒序排列。

### 托管控制台：日志与控制通道

启动时面板先把引擎的控制台接管过来（用的是 R5Flowstate 官方启动器同一套协议），再拉起一个**分离的**日志守护 `__logd`：

```
面板 / CLI ──(127.0.0.1:临时端口 + 随机令牌)──► __logd ──(R5F_CONSOLE_IN 管道)──► 引擎控制台
                                                  │
                                          追加写入 logs\<版本>-<端口>-<时间>.log
```

引擎通过 `R5F_HOSTED_CONSOLE` / `R5F_CONSOLE_PIPE` 把控制台输出写进命名管道，守护进程落盘；`R5F_CONSOLE_IN` 反向传输入，所以 `console` / `players` / `kick` 这些命令能在真实服务器控制台上执行。

- **关掉终端不影响服务器和日志**：守护进程与引擎都是分离进程，日志文件随时可以 `logs -f` 追。
- **控制通道全回环**：端口由系统分配、令牌每次启动随机，不新增公网端口。远程运维走 SSH / 私网隧道。
- 不想要这套（比如你要看引擎自己的窗口）：`start --no-host`——代价是日志只在引擎窗口里，`logs` 不再有新内容。

### 回执：命令到底有没有生效

引擎对命令的回答只有四种，面板逐类如实汇报：

| 回执      | 典型输出                                         | 含义                                                                                   |
| --------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `success` | `Kicked '1' from server`                         | 明确动作行                                                                             |
| `unknown` | `Command 'x' doesn't exist; request 'x' ignored` | 命令不存在                                                                             |
| `usage`   | `usage 'sv_addbot': name(string) teamid(int)`    | 参数用错                                                                               |
| `silent`  | 没有任何输出                                     | 命令存在但引擎不回话（`ban` / `unban` / `banlist_reload` / `bridge_chat_announce` 等） |

**静默不是成功。** 这一类操作只会报告"已发送（引擎无回执）"。

### cfg 同步

`platform/cfg/system/autoexec_server.cfg` 在启动参数之后执行，里面本来就写着 `hostname` / `spire_host_visibility` 等行。启动前面板把这些行同步成面板值（**只改已存在的行**，保留缩进与注释），日志区会打印同步了什么：

```
▶ 启动服务器   (r5-server start)
已同步 platform/cfg/system/autoexec_server.cfg: spire_host_visibility "2" → "0"（否则 cfg 会覆盖面板设置）
```

设置页对这类字段显示 `cfg≠` 与行号。

### 日志分片与健康

- 每次启动写一份 **`logs\<版本>-<端口>-<YYYYMMDD-HHMMSS>.log`**，按 `settings.logRetention` 保留最近 N 份；`logs --all` 列出分片，runid 就是尾部的时间戳。
- 引擎自己每次运行也写 `platform\logs\server\<uuid>\{error,warning,script_warning}.log`，`latest.txt` 指向本次——`health` / 体检页读的就是它。**`error.log` 非空即本次运行有问题**；级别按文件与词判定，`Native(E)` 前缀本身不是错误级别。
- ⚠️ 引擎日志含运行期密钥（如 `Installed NetKey: '…'`），**分享日志前先检查**。

## 升级与回退

设计目标：**换版本不动运维配置，出问题能退回。**

```powershell
# 1. 把新版本解压到根目录，与旧版本并列（旧目录先留着）
.\r5-server.exe list                       # 确认新版本被识别

# 2. 升级：校验三件套 → 备份当前版本的运维文件到 backups\<时间戳>\ → 迁移 → 切换 current
.\r5-server.exe upgrade --to r5f-dedi-1.0.14 --yes

# 3. 生效并确认
.\r5-server.exe restart
.\r5-server.exe status
.\r5-server.exe logs -f
```

迁移范围由 `--carry` 决定：

| 取值             | 迁移内容                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `config`（默认） | `mods\` 以外的运维文件：`platform\playlists_r5_patch.txt`、`r5f_map_names.txt`、`r5f_wip_maps.txt`、`platform\cfg\**` |
| `all`            | 上面这些 **+ `mods\` 整个目录**                                                                                       |
| `none`           | 不迁移，只切版本（想用新版本自带配置时）                                                                              |

**回退**：旧版本目录没被删除，`use` 回去再 `restart` 即可；配置从 `backups\<时间戳>\` 拷回。确认新版本稳定后旧目录与备份可以自行删除（面板不会自动清理）。

**换 `r5-server.exe` 本身前先停服**——托管控制台运行时，日志守护就是这个 exe，文件被占用：

```powershell
.\r5-server.exe stop --all
# 覆盖 r5-server.exe
.\r5-server.exe status
```

## 多开实例

同一个版本目录可以跑多个实例，各用各的端口：

```powershell
.\r5-server.exe start --port 37015 --force
.\r5-server.exe start --port 37016 --force
```

内存按 **每实例 6.5 GB 提交 / 3.2 GB 工作集**预留；空闲约 0.1 核，开局加载约 1 核 × 20 秒。

## 常见问题

| 现象                                    | 处理                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `start` 30 秒内报「没有出现服务端进程」 | `doctor` 看三件套是否齐全、Defender 是否已排除；确认 `r5apex_ds.exe` `server.dll` `loader.dll` 都在版本目录根 |
| `start` 报 UDP 端口被占用               | 已有实例在跑：`status` 看 pid，或 `stop --all`；也可换端口                                                    |
| 玩家连不上                              | 云防火墙 + Windows 防火墙都要放行 UDP；`status` 里确认端口已绑定                                              |
| 日志文件一直空                          | 这次是 `--no-host` 启动的（日志只在引擎窗口），去掉该参数重启                                                 |
| 内存吃紧（8 GB 机器）                   | `setup` 会把页面文件设成固定大小；能加到 16 GB 更稳                                                           |
| 换图时卡顿                              | 同上，页面文件太小或机械盘；内容盘建议 NVMe                                                                   |
| 开机没自启                              | `autostart status`；`logon` 触发的任务需要自动登录（`netplwiz`）或重启后登录一次                              |
| 命令看起来"没反应"                      | 看回执类别：`silent` 表示引擎不回话（不是失败），`unknown` 才是命令不存在                                     |
| 列表里看不到自己的服                    | 主服按你上报的地址探不到。见下面「上架失败排查」                                                              |

### 上架失败排查（列表里看不到自己）

`Unable to communicate, please forward your ports and check if the server is publicly accessible.` 是**主服回的 `error`**，引擎只转述：引擎 POST `/spire/hosts/publish` 上报自己的 `ip:port`，主服探不到就不上架。它会进 `error.log`，所以 `health` 报红，但服务器没崩。

| 事实                                                                                                                          | 依据                                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 上报的 `ip` 取自 cvar `hostip`（"Host game server ip"）；NAT 主机上实测是 `[::1]:0`（引擎取不到对外地址）                     | publish 报文与 cvar dump 同值                            |
| 用 `+hostip <公网IP>:<端口>`（或只写 IP）实测**能**改写上报值；`net_public_adr` 无效                                          | 改完 publish 的 `ip` 立即变化                            |
| **publish 必须从主机自己的公网 IP 出去**：主机上跑代理/VPN（TUN 模式，如 Clash Verge）时主服看到的是代理出口 IP，一样判不可达 | 实测：代理在时一直失败，给主服域名加直连规则后立即上架   |
| 主服确实会 UDP 探测那个 `ip:port`，且本机引擎会应答                                                                           | `pktmon` 抓包可见探测主机 ↔ 本机 `37015` 双向 UDP        |
| 主服列表可直接查：`POST https://play.r5flowstate.org/spire/hosts`，body `{"version":"R5FlowstateSDK002"}`                     | 官网前端 JS 里的接口，回 `servers[]`                     |
| 那句英文（与 `rate limit exceeded`）是主服文案，二进制里搜不到                                                                | 只出现在 `/spire/...` 回包之后                           |
| TCP 通 ≠ UDP 通；本构建没有 A2S，外部 UDP 探针没回应不能定罪                                                                  | 云侧按「协议 + 端口」逐条放行；`server.dll` 搜不到 `A2S` |

要看的就四处：面板「可见性」= 公开（为 0 时面板传 `-offline`，根本不上报）；**主机上没有会改出口 IP 的代理/VPN**（有就给主服域名加直连规则或退出）；附加参数 `+spire_showdebuginfo 1` 后看 publish 的 `ip`（不是公网地址就补 `+hostip <公网IP>:<端口>`）；两道门放行 UDP（云防火墙 + `setup --ports`），云侧放行与否看 RST/超时——放行的端口没人监听回 `ConnectionRefused`，没放行的只会 `timeout`。

## 已知边界

- **`ban --minutes` / `--reason` 不支持**：封禁时长与原因是 Spire 侧的模型，面板只发 `ban <target>`；给了这两个参数会直接报错退出，不会把半截命令发到引擎。
- **`mute`（禁言）未实现**：本构建没有可用的禁言命令。
- **`say` / `chat_announce` 不存在**：实测引擎报错。广播公告用 `announce`（`bridge_chat_announce`）+ `announcements` 编辑文案表。
- **`fs_1v1` 模式下多机器人会崩服**：实测同时放 2 个机器人时脚本报 `_1v1_match.nut InputChanged is not a registered signal` 并 `Shutdown host game`（`error.log` 会记录，`health` 立刻报红）。用机器人验证 1v1 时**只放一个具名机器人**（`bots add --name ProbeBot --team 1`）。
- **机器人不可封禁**：`spawnbots` / `sv_addbot` 造出来的假玩家 `uniqueid == "0"` 且无地址，只能踢。
- **踢人必须带引号**：`kick "<userid>"`——不带引号无效，面板已处理。
- **封禁/解封无回执**：引擎不回话，面板无法确认结果；`banlist.json` 由引擎在首次真正写入封禁后生成，不一定存在。
- **Windows 限定**：所有进程、端口、防火墙、提权逻辑都依赖 PowerShell 与 Win32 API。
- **控制通道只回环**：不提供远程管理端口；远程运维走 SSH / 私网隧道。
- **`r5f-dedi` 目录只读**：面板不会修改引擎内容，除了 cfg 同步与用户主动编辑的公告表。
- **`hostport` 面板不同步**：`-port` 只管绑定，对外端口是 cfg 的 `hostport`（`startup_dedi_default.cfg` 里钉 `"37015"`，不在 cfg 同步表内）→ 换端口要么就用 37015，要么手工改那一行。
- **`statsUpload=off`（`+fs_stats_url ""`）实测没关掉上报**：引擎把空值解析成了**别的 token**（实测 `"fs_stats_url" = "-ansicolor"`）。用这个开关前先核对引擎回显的那行。

## 开发

所有命令都从项目根目录执行；只有一份 `package.json`、`bun.lock` 与 `tsconfig.json`，不需要切换子项目目录。

```text
src/                 CLI、共享业务逻辑与界面入口 app.tsx
  routes/            页面
  components/        UI 组件
  lib/               界面会话与主题
native/              Rust 原生宿主与 Cargo.lock
scripts/             路由生成与发布产物摆放
vendor/solid-gpui/    固定提交的上游子模块
vite.config.ts       根目录 Vite 接入
rust-toolchain.toml  根目录 Rust 工具链
```

```powershell
git submodule update --init --recursive
bun install
bun run dev                    # 源码方式运行面板（改代码即时生效）
bun run cli --help             # 真实后端 CLI 帮助
bun run dev:cli status         # 模拟后端 CLI（不打开窗口）
bun run build                  # 编译单文件 r5-server.exe（bun-windows-x64，minify）
bun update --latest            # 依赖升到最新（受下面那条 24 小时冷却期约束）
```

依赖一律取最新，但**只装发布满 24 小时**的版本：根目录 [`bunfig.toml`](bunfig.toml) 设了 `install.minimumReleaseAge = 86400`，`bun install` / `bun add` / `bun update` 都会过滤掉当天刚发布的版本，没有豁免名单。因此 `bun update --latest` 有时会**退**到上一个合规版本（比如当天刚发的 oxlint 要等满一天才装得上），第二天重跑一次即可跟上。

### macOS 本地开发（模拟服务器）

不需要下载 Windows 服务端，也不需要 Wine。运行的是同一个 **Solid GPUI 原生面板**，
只把引擎进程与 Windows 主机能力换成本地模拟实现；`src/panel.ts`、设置/档案、文件解析、
TCP 控制通道和日志读取仍走正常代码。窗口标题和所有页面的顶部都会标明「模拟」。

首次准备：安装 Bun、Rust/rustup 和完整 Xcode；Xcode 需要 **Metal Toolchain**，仅装命令行工具不够。

```sh
git submodule update --init --recursive
bun install
xcodebuild -downloadComponent MetalToolchain  # 未安装时执行，GPUI 编译着色器需要它
bun run gui:dev                              # 原生窗口 + Vite 热重载 + 模拟后端
```

在窗口里点「启动服务器」，即可看到两个模拟真人与一个机器人、实时日志和模拟运行指标。
首启自动生成两份微型版本夹具（`1.0.13-dev` / `1.0.14-dev`），可以测试版本切换、升级备份。
也可以从另一个终端操作同一份实例：

```sh
bun run dev:cli start
bun run dev:cli players --json
bun run dev:cli bots add --name ProbeBot
bun run dev:cli mode set fs_dm
bun run dev:cli announce on
bun run dev:cli stop
```

**隔离与持久化：**两个入口都显式设置 `R5F_DEV=1`。数据只写到仓库的 `.dev/r5f/`
（若宿主声明了 `R5_SERVER_ROOT`，则在它下面的 `.dev/r5f/`），已加入忽略规则。
状态、档案、公告、主机配置、名单、备份和日志跨进程保留；夹具只补缺失文件，不覆盖编辑。
重启模拟引擎会重新生成初始玩家。关闭面板不会停止模拟引擎；用面板停止按钮或 `dev:cli stop` 停止。
要恢复全新数据，先关闭开发窗口并停止实例，再删除 `.dev/r5f/`，下次运行会重建。
原有 `bun run gui` / `bun run dev` 不自动开启模拟，Windows 的真实服务端流程不变。

**场景控制：**以下命令可以在面板控制台直接输入，也可以用 `bun run dev:cli console '<命令>'`：

| 命令             | 效果                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| `dev_empty`      | 清空玩家，验证空态                                                     |
| `dev_fill`       | 填满到 60 人，验证列表与满员状态                                       |
| `dev_error`      | 写入本次模拟错误记录，验证体检异常                                     |
| `dev_recover`    | 清除模拟错误和断连计数                                                 |
| `dev_disconnect` | 断开下一次控制连接，验证错误反馈；后续连接恢复（可能被面板轮询先消费） |

可以开发的流程包括：启动/停止/重启、版本、配置档案、设置与 cfg 同步、玩家/机器人、
踢人/封禁/解封回执与本地台账、模式/地图、公告编辑与轮播开关读回、日志、健康、主机配置反馈。

**不是引擎兼容性验证：**地图/模式清单、CPU/内存/端口状态和玩家都是模拟数据；不会绑定真实游戏 UDP、
连接 Spire、上传统计、发送真人聊天或运行游戏脚本。封禁名单使用明确标注的模拟结构，不模拟登录封禁。
Windows 防火墙、页面文件、Defender、电源与自启只读写模拟状态，不修改 macOS；
`autostart run` 明确返回不支持。仅支持一个后台托管实例，不支持 `--foreground`、`--no-host` 或强制多开。
真实引擎命令覆盖有限，未实现的控制台能力、自动到期解封和真实联网行为仍需在 Windows 验证。

模拟实现集中在 `src/dev.ts`（开关与目录）、`dev-fixtures.ts`（夹具）、`dev-engine.ts`（进程/控制台）、
`dev-protocol.ts`（实例身份与鉴权停止）、`dev-host.ts`（主机状态）。不要在页面里再造一套假数据。

源码结构（`src/`）：逻辑层，CLI 与面板共用

| 文件                 | 职责                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------ |
| `cli.tsx`            | commander 入口：所有子命令注册 + 无参数时打开面板                                    |
| `commands.ts`        | 命令实现：启动/停止/升级/设置/玩家/审核/公告/模式/健康；启动参数构造；控制通道客户端 |
| `panel.ts`           | 面板的稳定 API 面：实例快照、日志读取器、动作、档案、清单、公告、健康、封禁台账      |
| `settings-fields.ts` | **唯一**的设置项声明表：渲染、校验、CLI、面板共用                                    |
| `state.ts`           | `r5-server.json` 读写与容错（含面板上次停留的页面）                                  |
| `versions.ts`        | 版本发现、三件套校验、排序、升级迁移清单                                             |
| `tap.ts`             | 托管控制台：命名管道、`__logd` 日志守护、回环控制口                                  |
| `cfg.ts`             | 引擎 cfg 读取与 cvar 同步（`shell-quote` 解析，行级重写）                            |
| `catalog.ts`         | 从版本目录读真实清单：地图名、模式目录（按家族分组）                                 |
| `announcements.ts`   | 公告表解析/渲染/校验（`chat_announcements.csv`）                                     |
| `inspect.ts`         | 面板数据采集：详情、体检、主机能力、运行健康                                         |
| `win.ts`             | Windows 探测与动作：进程、端口、防火墙、页面文件、Defender、计划任务、电源、UAC      |

界面与业务模块统一放在根 `src/`：`src/routes/` 是页面，`src/components/` 是共用积木，`src/lib/` 是会话 store；根 `native/` 是原生宿主（Rust）。界面通过 `src/panel.ts` 与业务逻辑层交互。

### 桌面端（面板）的构建

界面用 [solid-gpui](https://github.com/Cyenoch/solid-gpui) 写：JS/TS 跑逻辑，原生宿主负责渲染。仓库把 solid-gpui 作为固定提交的子模块放在 `vendor/solid-gpui`。首次克隆或更新代码后先补齐子模块；`bun install` 只安装 JS 依赖，不会下载 Rust 源码子模块。

```powershell
# 以下在项目根目录逐条执行；某一步失败就先处理，不继续后续步骤。
git submodule update --init --recursive
bun install
bun run build                  # 编译 Windows x64 CLI
bun run gui:stage              # 构建 bundle + 编译宿主 + 把 exe/js 摆到仓库根
.\r5-server-gui.exe --production

# 日常开发无需 stage：自动构建宿主、生成绑定并启动 Vite
bun run dev
# 本地模拟服务器（不连接真实玩家）
bun run gui:dev
```

需要 Rust 工具链（根 `rust-toolchain.toml` 指定版本，cargo 会自动拉）。Windows 还需要 Visual Studio C++ Build Tools（MSVC）与 Windows SDK。`src/generated/native.ts` 与 `src/routeTree.gen.ts` 都是构建产物，不入库，`dev` / `gui:build` / `gui:stage` 会自动生成。

根目录也可单独运行 `bun run host:build`、`bun run host:build:release`、`bun run routes`。`bun run gui:stage:release` 构建 release 宿主、生成 JS 包并摆放到根目录；Windows release 需要 SDK 的 `fxc.exe`。package scripts 里的 `&&` 由 Bun shell 执行，兼容 Windows PowerShell 5.1；不要在 PowerShell 提示符里粘贴多条 `&&` 命令。

若 Cargo 报 `vendor/solid-gpui/vendor/gpui-kit/crates/component/Cargo.toml` 不存在，先在根目录重新运行 `git submodule update --init --recursive`，不要反复运行 Cargo 或 Bun 安装。旧 CLI 的 `--hot` 曾对 Bun 缓存中的 `shell-quote/parse.js` 报监听警告；现在 `dev` 使用 Vite，CLI 不使用该监听器。

当前 solid-gpui 子模块 pin 为 `e5448f6`（Windows Support）。历史痛点的修复状态、已删除的临时绕法、仍需上游处理的问题与验证范围见
[docs/solid-gpui-notes.md](docs/solid-gpui-notes.md)。

本轮保持外部 Bun + stdio，不切换上游实验性的内嵌 Bun 静态打包。Windows debug 宿主现已内嵌着色器源码及 include，不再依赖构建机源码路径；需要重新编译 EXE，单换 JS 不生效。Windows release 构建仍需 Windows SDK 的 `fxc.exe`（可用 `GPUI_FXC_PATH` 指定），本面板的 Windows x64/MSVC 发布验收仍待目标机验证。

平台与产品取舍：

- 应用线程由上游 runner 管理：Windows 默认预留 16 MiB 栈，可用 `SOLID_GPUI_APP_STACK_BYTES` 指定字节数；macOS 保持 AppKit 所需的主线程。本面板过去只验证过 Windows 的 256 MiB，升级后的 16 MiB 仍需在目标 Windows 环境做压力验证，不能把上游示例通过当作本面板通过。
- `.SystemUIFont` 的 Windows 字体解析已由上游修复，宿主不再覆盖成指定字族。
- 保留 `motion::set(Reduced)` 是运维面板的产品取舍，不再声称 `Button` / `TabBar` 必崩；首帧配置通过 `ComponentHost::with_initialize` 完成。
- 占剩余空间的容器（外壳内容区、页面里靠 `flexGrow` 撑开的列）必须同时给出零初始尺寸（横向 `width: 0`、纵向 `height: 0`），否则布局引擎会先按内容测一遍整棵子树，长页面滚动会明显变卡。[实测](docs/solid-gpui-notes.md#已修复高内容页面滚动卡顿用户已于-2026-09-16-确认)

默认 stdio 传输负责渲染器随宿主退出；游戏服务器与日志守护仍独立存活。

提交前跑完整闸门（oxlint 规则 + 类型诊断 + oxfmt 格式，`denyWarnings` 打开，有 warning 也算不过）：

```powershell
bun run check                  # 完整闸门：typecheck + fmt:check
bun run lint:fix               # 应用可自动修复的规则
bun run fmt                    # 写回格式
```

规则不适用时在 `.oxlintrc.json` 里显式关闭并写清原因，不要在源码里散落行内 `oxlint-disable`。

领域词汇见 [CONTEXT.md](CONTEXT.md)，实现参考见下文，设计与工单见 `.scratch/fleet-ops/`，仓库约定见 [AGENTS.md](AGENTS.md)。

## 模块地图（`src/`）

| 文件                 | 职责                                                                               |
| -------------------- | ---------------------------------------------------------------------------------- |
| `cli.tsx`            | commander 入口；所有子命令；help 中文化（输出层）                                  |
| `commands.ts`        | 命令实现：启动/停止/重启/升级/设置/玩家/控制台/日志…；构造启动参数；控制通道客户端 |
| `state.ts`           | 实例、模板、选择指针与历史记录；旧数据迁移、跨进程串行提交、原子文件替换           |
| `versions.ts`        | 版本目录发现、备份、切换                                                           |
| `win.ts`             | Windows 探测与动作：进程、端口、防火墙、页面文件、Defender、计划任务、电源         |
| `tap.ts`             | `__logd` 日志守护：管道、日志文件、控制口；日志尾部/增量读（水位线）               |
| `inspect.ts`         | 详情、体检、主机能力与健康数据采集                                                 |
| `settings-fields.ts` | **唯一**的设置项声明表：渲染、校验、CLI、面板共用                                  |
| `panel.ts`           | 面板稳定 API：实例生命周期、模板、日志、玩家、公告、健康、封禁                     |
| `catalog.ts`         | 从版本目录读真实清单：地图名、playlist、模式目录（按家族分组）                     |
| `cfg.ts`             | 读/校验/行级重写引擎 cfg（`shell-quote` 解析）                                     |
| `serverinfo.ts`      | 日志摘要与 status 头部解析                                                         |
| `gui.ts`             | 面板启动器：源码走根目录 Vite，发布走 CLI 同级原生宿主                             |
| `paths.ts`           | 程序目录与显式编译标记；不混用状态目录或 Bun 安装目录                              |
| `instances.ts`       | 实例工作副本、端口族与启动排他锁                                                   |
| `releases.ts`        | 官方文件名版本发现、下载、校验、解压与原子安装                                     |
| `mode-templates.ts`  | 源码验证过的玩法参数及生效时机                                                     |
| `telemetry.ts`       | 实际采样与本地历史曲线                                                             |

界面入口 `src/app.tsx`、路由、组件与共享业务代码都属于同一个 TypeScript 项目；`native/` 是原生宿主（Rust）。`scripts/`、Vite 与 Rust 工具链配置都在根目录，不再有独立桌面工作区。

## 不变量（改代码时必须保持）

1. **面板值优先于引擎 cfg**：启动前同步已存在的 cvar 行，不新增注入命令。
2. **一次声明，处处一致**：设置项只在 `settings-fields.ts` 声明；CLI 与面板不得各写一套校验。
3. **不虚构引擎能力**：命令/参数必须有实测或 `server.dll` 证据；不支持的能力写进文档并标注未验证。
4. **输出如实**：静默、未验证、猜测都要显式标注。
5. **面板说人话，不泄露标识**：设置项不显示 cvar 名（挂在 `FieldDef.engineName`，只给 CLI）；**UUID 任何位置都不出现全量**（运行编号只显示前 8 位）；pid、端口、日志/名单文件路径属于运维必需信息，允许出现在实例、日志、封禁名单页。日志与 `banlist.json` 原文例外 —— 那是引擎原样输出，排障要看原文。
6. **Windows 脚本 ASCII**：`*.bat`/`*.ps1` 内容保持 ASCII（中文 Windows 的 ANSI 解析会毁 UTF-8 无 BOM）。
7. **无 `any`**：`unknown` + 类型守卫；静态映射用 `Record`；已发布契约用具名类型。
8. **共享版本只读**：运行与用户修改全部落在实例自己的工作副本；换版本采用暂存与原子交换。
9. **不新增公网管理面**：控制通道只回环；远程运维走 SSH/私网隧道（另议）。
10. **输入态吃掉键盘**：只要有文本在收集字符（控制台提示行、对话框、设置项编辑中），可打印字符一律归输入；`q` 退出、`:` 控制台这类**可打印**全局快捷键只在无人输入时生效。新增文本输入面或可打印快捷键时，两处同时改（`routeKey` 的闸 + 本条）。

## 引擎事实（有证据，可引用）

- 启动契约：`-dedicated -multiple -port N +hostport N +s2sPort N+1 +clientport N-10`，以及服务器名、可见性、认证、玩法和地图等参数；环境 `VPROJECT=1`、`FROM_R5F_LAUNCHER=1` 必需。
- 测量：常驻约 3.16 GB、私有提交约 6.46 GB、每实例 ~15–20 线程；换图约 1 核 × 20 s。
- 命令/用法（实测）：`kick "<userid>"`（**不带引号无效**）、`spawnbots <count>`、`sv_addbot <name> <teamid>`、`help <cvarname>`、`convar_findByFlags <string>`、`bridge_setmode <playlist> <map>`、`bridge_chat_announce`、`playlist_override_set <var> <value>`、`banlist_reload`、`changelevel <map>`、`status`。
- 不存在（实测报错）：`say`、`say_team`、`chat_announce`、`mute`、`find`、`cvarlist`、`mp_timelimit`。
- 级别：`Native(E)/(F)` **不是**错误级别（`Native(E)` 里有正常行）；判级别按文件与词。
- 外发：1v1 对战统计 POST 到 `https://play.r5flowstate.org/stats/1v1/ingest`（`fs_stats_url`，置空即关闭）；Spire 匹配/封禁走 `spire_matchmaking_hostname`；`-offline` 关闭匹配。
- Spire 上报（实测日志 + 主服接口）：每 `spire_host_update_interval`（默认 5 s）POST `https://play.r5flowstate.org/spire/hosts/publish`，body = `name` `description` `hidden` `map` `playlist` `ip` `port` `key` `checksum` `version` `numPlayers` `maxPlayers` `timeStamp` `password`。
- 上架条件（实测）：`ip` 正确（`+hostip <公网IP>[:端口]`，引擎在 NAT 主机上自测为 `[::1]:0`，`net_public_adr` 无效）+ **publish 从主机自己的公网 IP 出去**（主机上跑代理/VPN 会改出口 IP，主服照样判不可达；实测加直连规则后立即上架）+ 两道门放行 UDP。主服会 UDP 探测该 `ip:port`（`pktmon` 抓包可见双向包），探测不过即回 `{"success":false,"error":"Unable to communicate, please forward your ports and check if the server is publicly accessible."}` —— 主服文案，引擎原样打印（二进制里搜不到，`rate limit exceeded` 同理）。
- 列表查询（实测）：`POST /spire/hosts`，body `{"version":"R5FlowstateSDK002"}` → `{servers:[{ip,port,name,numPlayers,map,playlist,key,hidden,hasPassword,maxPlayers,description,checksum,allowedMods,requiredMods,modsProfile}],players,capacity}`；空 body 回 `{"error":"Missing required fields.","success":false}`。官方 `r5flowstate.org/host/`：探测不过的服不会出现在列表。相关 cvar：`hostip`、`hostport`（cfg 默认 37015）、`clientport` 37005、`s2sPort` 37016、`spire_showdebuginfo`（1 = 打印请求/回包）、`_sdk_apply_launch_convars`（`+cvar` 启动参数压回 cfg 之上）。
- 日志含运行期密钥（`Installed NetKey: '…'`）→ 分享日志前注意。
