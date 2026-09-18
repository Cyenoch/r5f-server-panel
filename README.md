# r5-server —— R5Flowstate 服务器管理面板

管理 **R5Flowstate 专用服务端（`r5f-dedi-*`）** 的 Windows 原生图形面板：版本下载、持久实例、玩法模板、多实例运行、控制台、玩家管理与真实观测数据。发行版只需一个 EXE，不提供面向用户的命令行。

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

| 项         | 要求                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| 系统       | Windows x64 图形桌面；真实服务端操作依赖 PowerShell 与 Win32 API，验证范围见[适配记录](docs/solid-gpui-notes.md) |
| 服务端内容 | 一个完整版本目录，根目录同时包含 `r5apex_ds.exe`、`server.dll`、`loader.dll`                                     |
| 内存       | 每实例预留 **3.2 GB 工作集 / 6.5 GB 提交**；8 GB 机器建议固定页面文件                                            |
| 运行面板   | 仅 `r5-server.exe`；不需要安装 Bun，也不需要相邻 JS、原生宿主或源码                                              |
| 从源码构建 | Bun、递归子模块、Rust，以及内嵌 Bun 的固定构建工具链，见[开发](#开发)                                            |

## 快速开始

1. 把 `r5-server.exe` 放到可写目录，例如 `D:\r5-server\`，双击打开。
2. 在「服务端版本」安装版本，或把已经解压的完整版本目录放到 EXE 同级。
3. 在「主机环境」检查防火墙、页面文件、Defender 排除与自启；审阅变更后应用主机配置。需要权限时会弹出 UAC，取消不会被当作成功。
4. 创建玩法模板和服务器实例，选择版本及端口，启动实例，在控制台与健康页确认状态。

玩家用 R5Flowstate 启动器在服务器列表里连接公开实例，或使用 `connect <公网IP>:<端口>`。

> **云服务器两道门都要开**：控制台的安全组/防火墙放行同样的 **UDP** 端口，与 Windows 防火墙是两套独立规则，只开一边外网连不上。

## 图形面板

直接打开 `r5-server.exe` 即进入图形面板。界面使用 [solid-gpui](https://github.com/Cyenoch/solid-gpui) 原生渲染，业务逻辑与内部后台任务共用根 `src/` 下的实现。

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

发布 EXE 内静态链接 GPUI 与 Bun/JSC，同时内嵌界面和 worker 的模块图。没有启动器转发、安装器解包或磁盘 JS 回退；`dist/` 只放发布产物，JS 中间文件在 `native/target/bundles/`，原生构建缓存位置见下方构建说明。

需要独立生命周期或提权的任务，通过同一个 EXE 的内部 `--worker` 入口运行：主机配置、计划任务、日志守护、模拟引擎。它不是公共 CLI。游戏服务端与日志守护是分离进程，**关闭面板不等于停服**；重开面板可继续管理。

开发仍使用 Vite + 外部 Bun/stdin 传输：根目录运行 `bun run dev`。默认真实后端，只有 `R5F_DEV=1` 开启模拟。程序目录由宿主声明，独立于 `R5_SERVER_ROOT` 数据父目录；模拟数据位于该父目录下的 `.dev/r5f/`。

## 默认玩法：1v1

本机默认已固定成 1v1：`playlist = fs_1v1`、`map = mp_rr_arena_habitat`（都在 `r5-server.json` 里，面板"游戏设置"可改）。

- `fs_1v1` 是版本自带的 R5F 模式（`platform/playlists_r5_patch.txt`），家族 `1v1`，声明了 11 张可轮换地图（`fs_1v1_rotate_mp_rr_*`）。
- 运行中换模式/地图无需重启进程，但会中断对局；在实例工作区明确选择「重新加载玩法」。
- 模式自己的参数（装备套装 `fs_1v1_locked_set`、自定义武器 `custom_1v1_weapons_*`、轮换图开关）写在该模式的 `vars` 块里，改完 `changelevel` 或重启生效。
- 同家族还有 `fs_lgduels_1v1`（R99 上膛决斗）。
- 1v1 对战统计默认会 POST 到 `play.r5flowstate.org`；不想外发就把"1v1 数据上报"设为"关闭上报"（启动参数追加 `+fs_stats_url ""`）。

## 配置

配置保存在根目录的 `r5-server.json`，包含 `instances`、`templates`、`selectedInstanceId` 与 `history`。实例保存名称、版本、设置、模板绑定和运行记录；运行记录中的 `applied` 是启动快照，`live` 与 `overrides` 是引擎已确认的运行期状态。

旧的单实例/配置档案自动迁移为持久实例；保留原运行记录。写入先取得 SQLite 跨进程写锁（`.state-lock.sqlite`），重读并只合并本次变更，再原子替换 JSON，避免多个面板与后台任务互相覆盖。

共享安装目录不写运行数据。每个实例的工作副本约需一个完整发行版的空间（官方 1.0.13 展开约 4.47 GB）；支持 reflink 的文件系统可减少物理占用，Windows 通常是真实复制。版本切换先复制到暂存目录，成功后交换，保留公告和封禁文件。

设置项以 `src/settings-fields.ts` 为唯一声明与校验来源，下面是主要字段：

| 字段           | 类型            | 默认                  | 说明                                                                           |
| -------------- | --------------- | --------------------- | ------------------------------------------------------------------------------ |
| `hostname`     | string          | `R5F Server`          | 服务器名，1–60 字符，显示在服务器列表与控制台标题                              |
| `hostip`       | string          | 空                    | `+hostip`：对外公布的公网地址，NAT/云主机必填；可一键获取本机公网 IP 填入      |
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

这些设置在实例设置页修改；保存配置与应用到运行中的引擎是两个独立动作。

## 工作原理

### 目录布局

```
r5-server\
├─ r5-server.exe            唯一程序文件：原生 GUI + 内嵌 Bun + 内部 worker
├─ r5-server.json           实例、模板、运行记录与操作历史
├─ instances\              实例私有工作副本
├─ logs\                   每次运行的日志分片与守护 pid 文件
├─ backups\                保留的历史运维文件备份
└─ r5f-dedi-1.0.13\         一个版本一个目录，三件套齐全才会被识别
   ├─ r5apex_ds.exe  server.dll  loader.dll
   └─ platform\ paks\ vpk\ maps\ mods\ cfg\ audio\ r2\ ...
```

默认数据父目录是 EXE 所在目录，源码开发时为仓库根；可用 `R5_SERVER_ROOT` 指定。版本目录名字不限，只要三件套齐全就会出现在版本库；名字含 `x.y.z` 时按版本号倒序排列。

自启任务由新的登录/调度会话运行，不继承当前面板的临时环境。使用自定义 `R5_SERVER_ROOT` 时，应为任务所属账户配置持久的绝对路径并重新登录；不能只在启动面板的终端临时设置。默认 EXE 同级数据目录不需要此配置。

### 托管控制台：日志与控制通道

启动时面板先把引擎的控制台接管过来（用的是 R5Flowstate 官方启动器同一套协议），再拉起一个**分离的**日志守护 `__logd`：

```
面板 ──(127.0.0.1:临时端口 + 随机令牌)──► 日志 worker ──(R5F_CONSOLE_IN 管道)──► 引擎控制台
                                                  │
                                          追加写入 logs\<版本>-<端口>-<时间>.log
```

引擎通过 `R5F_HOSTED_CONSOLE` / `R5F_CONSOLE_PIPE` 把控制台输出写进命名管道，守护进程落盘；`R5F_CONSOLE_IN` 反向传入指令，供面板控制台、玩家查询和管理动作使用。

- **关闭面板不影响服务器与日志**：守护进程与引擎都是分离进程，重开面板后可继续追踪日志。
- **控制通道全回环**：端口由系统分配、令牌每次启动随机，不新增公网端口。远程运维走私网或远程桌面。

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
启动服务器
已同步 platform/cfg/system/autoexec_server.cfg: spire_host_visibility "2" → "0"（否则 cfg 会覆盖面板设置）
```

设置页对这类字段显示 `cfg≠` 与行号。

### 日志分片与健康

- 每次启动写一份 **`logs\<版本>-<端口>-<YYYYMMDD-HHMMSS>.log`**，按 `settings.logRetention` 保留最近 N 份；在控制台页选择运行分片。
- 引擎每次运行还写 `platform\logs\server\<uuid>\{error,warning,script_warning}.log`，`latest.txt` 指向本次；健康页读取这些文件。**`error.log` 非空即本次运行有问题**；级别按文件与词判定，`Native(E)` 本身不是错误级别。
- 引擎日志含运行期密钥（如 `Installed NetKey: '…'`），**分享日志前先检查**。

## 升级与回退

服务端版本与面板程序分别更新：

1. 在版本库安装新版本，保留旧版本。
2. 在服务器实例的操作菜单中选择「编辑实例」，修改绑定版本；保存不会替换仍在运行的进程。
3. 重启该实例，在控制台与健康页确认状态。每个实例使用自己的工作副本，启动时应用已保存的设置和模板。
4. 需要回退时，重新绑定旧版本并重启该实例；已有备份不会自动删除。

**替换面板 EXE 前必须停止所有实例并关闭面板**：日志守护也运行这个 EXE，Windows 会保持文件占用。移到新目录后，在主机环境重新应用配置，更新计划任务中的绝对路径。旧 CLI 版本创建的任务也需要重建，不能继续沿用旧子命令。

## 多开实例

在服务器实例页创建或复制实例，为每个实例分配独立端口、模板与私有工作副本，再分别启动。同一实例拒绝重复启动，不靠强制参数绕过运行记录。

内存按 **每实例 6.5 GB 提交 / 3.2 GB 工作集**预留；空闲约 0.1 核，开局加载约 1 核 × 20 秒。

## 常见问题

| 现象                                 | 处理                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------- |
| 启动 30 秒内报「没有出现服务端进程」 | 在主机环境检查三件套与 Defender 排除；确认三个引擎文件都在版本目录根      |
| UDP 端口被占用                       | 在「运行中」检查实例与 pid，停止目标实例或修改端口；不要误杀其他服务端    |
| 玩家连不上                           | 云防火墙与 Windows 防火墙都要放行 UDP，并确认实际绑定端口                 |
| 日志文件一直空                       | 检查实例是否成功启动，以及托管控制台与日志守护的启动反馈                  |
| 内存吃紧（8 GB 机器）                | 在主机环境审阅并应用固定页面文件；能加到 16 GB 更稳                       |
| 换图时卡顿                           | 检查页面文件与磁盘；内容盘建议使用 NVMe                                   |
| 登录后没自启                         | 在主机环境检查计划任务与 EXE 路径；默认登录触发，需要用户登录             |
| 命令看起来"没反应"                   | 看回执类别：`silent` 表示引擎不回话（不是失败），`unknown` 才是命令不存在 |
| 列表里看不到自己的服                 | 主服按你上报的地址探不到。见下面「上架失败排查」                          |

### 上架失败排查（列表里看不到自己）

`Unable to communicate, please forward your ports and check if the server is publicly accessible.` 是**主服回的 `error`**，引擎只转述：引擎 POST `/spire/hosts/publish` 上报自己的 `ip:port`，主服探不到就不上架。它会进 `error.log`，因此健康页报红，但不代表服务器崩溃。

| 事实                                                                                                                          | 依据                                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 上报的 `ip` 取自 cvar `hostip`（"Host game server ip"）；NAT 主机上实测是 `[::1]:0`（引擎取不到对外地址）                     | publish 报文与 cvar dump 同值                            |
| 用 `+hostip <公网IP>:<端口>`（或只写 IP）实测**能**改写上报值；`net_public_adr` 无效                                          | 改完 publish 的 `ip` 立即变化                            |
| **publish 必须从主机自己的公网 IP 出去**：主机上跑代理/VPN（TUN 模式，如 Clash Verge）时主服看到的是代理出口 IP，一样判不可达 | 实测：代理在时一直失败，给主服域名加直连规则后立即上架   |
| 主服确实会 UDP 探测那个 `ip:port`，且本机引擎会应答                                                                           | `pktmon` 抓包可见探测主机 ↔ 本机 `37015` 双向 UDP        |
| 主服列表可直接查：`POST https://play.r5flowstate.org/spire/hosts`，body `{"version":"R5FlowstateSDK002"}`                     | 官网前端 JS 里的接口，回 `servers[]`                     |
| 那句英文（与 `rate limit exceeded`）是主服文案，二进制里搜不到                                                                | 只出现在 `/spire/...` 回包之后                           |
| TCP 通 ≠ UDP 通；本构建没有 A2S，外部 UDP 探针没回应不能定罪                                                                  | 云侧按「协议 + 端口」逐条放行；`server.dll` 搜不到 `A2S` |

要看四处：面板「可见性」设为公开（为 0 时启动带 `-offline`）；主机没有改写出口 IP 的代理/VPN；添加 `+spire_showdebuginfo 1` 后核对 publish 的 `ip`，必要时在「开服检查清单」或实例设置的「公网地址」里点**获取当前公网 IP**（问三家 HTTPS 回显服务要本机公网 IPv4，写成 `ip:游戏端口` 存进该设置；它只知道本机出网地址，代理/VPN 改出口时仍会判不可达）；云防火墙与主机环境配置均放行同一个 UDP 端口。

## 已知边界

- **封禁时长与原因不受引擎支持**：它们属于 Spire 侧模型；面板只发送引擎支持的 `ban <target>`。
- **`mute`（禁言）未实现**：本构建没有可用的禁言命令。
- **`say` / `chat_announce` 不存在**：实测引擎报错。使用面板公告页编辑文案并触发 `bridge_chat_announce`。
- **`fs_1v1` 模式下多机器人会崩服**：实测同时放 2 个机器人时脚本报 `_1v1_match.nut InputChanged is not a registered signal` 并 `Shutdown host game`。验证 1v1 时只添加一个具名机器人。
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
src/                 GUI、内部 worker 与共享业务逻辑
  routes/            页面
  components/        UI 组件
  lib/               界面会话与主题
native/              Rust 原生宿主与 Cargo.lock
scripts/             单文件发行版打包（Vite 之后交给上游公共打包器）
vendor/solid-gpui/    固定提交的上游子模块
vite.config.ts       根目录 Vite 接入
rust-toolchain.toml  根目录 Rust 工具链
```

```powershell
git submodule update --init --recursive
bun install
bun run generate               # 构建原生宿主并导出绑定（首次、或绑定变更后）
bun run dev                    # 源码方式运行面板（改代码即时生效）
$env:R5F_DEV = "1"; bun run dev # 模拟后端 GUI
bun run build                  # 只产出 JS bundle（native/target/bundles）
bun run package                # 生成单文件发行版 dist/r5-server.exe（见下节）
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
R5F_DEV=1 bun run dev                        # 原生窗口 + Vite 热重载 + 模拟后端
```

在窗口里点「启动服务器」，即可看到两个模拟真人与一个机器人、实时日志和模拟运行指标。
首启自动生成两份微型版本夹具（`1.0.13-dev` / `1.0.14-dev`），可以测试版本切换与实例隔离。所有操作通过面板完成。

**隔离与持久化：**模拟模式需要显式设置 `R5F_DEV=1`。数据只写到仓库的 `.dev/r5f/`
（若宿主声明了 `R5_SERVER_ROOT`，则在它下面的 `.dev/r5f/`），已加入忽略规则。
状态、档案、公告、主机配置、名单、备份和日志跨进程保留；夹具只补缺失文件，不覆盖编辑。
重启模拟引擎会重新生成初始玩家。关闭面板不会停止模拟引擎；重开面板后用停止按钮结束实例。
要恢复全新数据，先关闭开发窗口并停止实例，再删除 `.dev/r5f/`，下次运行会重建。
原有 `bun run dev` 不自动开启模拟，Windows 的真实服务端流程不变。

**场景控制：**以下指令在面板控制台输入：

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
模拟计划任务只保存配置，不执行真实系统自启；模拟引擎使用独立后台进程，不提供前台终端模式。
真实引擎命令覆盖有限，未实现的控制台能力、自动到期解封和真实联网行为仍需在 Windows 验证。

模拟实现集中在 `src/dev.ts`（开关与目录）、`dev-fixtures.ts`（夹具）、`dev-engine.ts`（进程/控制台）、
`dev-protocol.ts`（实例身份与鉴权停止）、`dev-host.ts`（主机状态）。不要在页面里再造一套假数据。

### 单文件发行版构建

`bun run package` 默认构建 **Windows x64 / release**，输出 **`dist/r5-server.exe`**。它只做两件事：先产出两个入口（app 入口走 `bun --bun vite build`；worker 入口用同一份 `vite.config.ts` 的 worker 模式经公开的 Vite `build()` API 构建，取**实际产出**的入口 chunk 与其解析出的输出目录，不猜产物文件名），再把「已构建的两个入口 + 应用 Cargo 工程（`native/Cargo.toml`、`features = ["embedded"]`、入口 `native/src/packaged-main.rs`）」交给上游公共打包器 `@solid-gpui/vite/embedded`。原生图准备、模块图序列化、生成并编译应用 crate、复核镜像机器类型与图摘要都在打包器内部完成；`dist/` 只在最后一步原子替换，失败不会覆盖此前成功发布的文件。两个入口键由打包器写进生成的 crate（`BUN_EMBEDDED_ENTRY` / `BUN_EMBEDDED_WORKERS`），宿主不再按文件名猜路径，也不再复制上游的原生清单校验、图解析或 crate 生成。

构建环境需要提前准备；这些工具只用于构建，**不随 EXE 分发**：

- Bun；Windows 使用 **x64 Bun**，包括在 ARM64 Windows 上构建。当前 Solid 编译器的 ARM64 WASI 路径不能在 Bun 正常初始化。
- Git 与完整递归子模块，且子模块必须停在仓库记录的 gitlink（当前 `f3f8590b`）：pin 文件 `crates/solid-gpui-bun-sys/bun-build.json` 只存在于该提交，工作树停在别的提交时打包器第一步就报读不到 pin。子模块内有未提交改动时先 `git stash`，再 `git submodule update --init --recursive`。根目录工具链见 `rust-toolchain.toml`。
- 内嵌 Bun 固定工具链：`nightly-2026-07-20`（含 `rust-src`）、LLVM/Clang/LLD **21**、Ninja **1.13.0**、CMake、Python 3、Perl，以及 Windows x64 目标的 **NASM**（BoringSSL 与 libjpeg-turbo 的 x86-64 汇编；缺它 configure 直接报 `nasm not found in toolchain`）。固定提交及版本以 `vendor/solid-gpui/crates/solid-gpui-bun-sys/bun-build.json` 为准。
- **行尾必须是 LF**：`bun_embed.patch` 自身是 LF，而 Git for Windows 默认 `core.autocrlf=true` 会把它检出成 CRLF，`git apply` 随即在 29 个文件上全部失败。把子模块配成 LF（`git -C vendor/solid-gpui config core.autocrlf false` 后重新检出该目录），并给打包进程设 `GIT_CONFIG_COUNT=1` / `GIT_CONFIG_KEY_0=core.autocrlf` / `GIT_CONFIG_VALUE_0=false` —— 打包器检出到缓存里的 Bun 源码同样必须保持 LF。
- **由该固定提交构建的 Bun 序列化器**（必需）：序列化载荷不带格式版本，打包器读 `bun --revision` 并拒绝任何其他提交；上游不会替你构建或下载它（`vendor/solid-gpui/docs/distribution.md`）。可以复用上游嵌入构建缓存里的那个（`SOLID_GPUI_BUN_CACHE` 目录下的 `bun-build/bun-debug`，由 `solid-gpui-bun-sys` 的嵌入构建产出），也可以自行从固定提交构建；两条路都用绝对路径经 `R5_BUILD_BUN` 传入。图目标平台与构建机不一致时（默认的 macOS → Windows 就是这样）还要用 `R5_BUILD_BASE` 给出**目标平台、同一提交**的 Bun，否则打包器会拒绝下载不受提交约束的基础可执行文件。
- Windows：Visual Studio C++ Build Tools、Windows SDK、PowerShell **7**（`pwsh` 在 PATH）。调用构建命令的终端仍可使用 PowerShell **5.1**；脚本只导入当前进程的 VS 开发环境，不修改全局配置。
- Windows release 着色器需要 SDK 的 `fxc.exe`，可通过 `GPUI_FXC_PATH` 指定。匹配 Bun 预编译依赖的 SDK/CRT 可用 `WINDOWS_SYSROOT` 指定；本机使用 SDK 10.0.26100 与 MSVC 14.44。

Git 自带的 Perl 通常在其 `usr/bin`，不一定已加入 PATH；Python 不能指向 Windows Store 的占位启动器。

在 ARM64 Windows 上构建默认 x64 目标时，还须确认 `clang-cl` 以 x64 为目标。固定 Bun 的工具发现会优先使用 `C:\Program Files\LLVM\bin`，仅调整 PATH 不一定生效。本次构建对 ARM64 默认的 Clang 使用当前 PowerShell 进程的 `$env:CL = '--target=x86_64-pc-windows-msvc'`，未替换全局 LLVM；原生 x64 Clang 不需要这项修正。

```powershell
git submodule update --init --recursive
bun install
rustup toolchain install nightly-2026-07-20 --component rust-src
rustup target add x86_64-pc-windows-msvc --toolchain nightly-2026-07-20
$env:R5_BUILD_BUN = "D:\tools\bun-pinned\bun.exe"   # 由固定提交构建的序列化器
bun run package
.\dist\r5-server.exe
```

缓存与调试选项：

| 选项                         | 用途                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--target <Rust triple>`     | 覆盖默认 Windows x64；支持上游目标矩阵里的 Windows/macOS x64、ARM64                                              |
| `--profile debug`            | 调试打包；默认 release                                                                                           |
| `R5_BUILD_BUN`               | **必需**：由固定提交构建的 Bun 序列化器（绝对路径）                                                              |
| `R5_BUILD_BASE`              | 目标平台、同一提交的 Bun 编译基线；图目标平台与构建机不一致时必需（默认的 macOS → Windows 就是这种情况）         |
| `R5_BUILD_SOURCE`            | 本地 Bun checkout 种子，避免重新下载源码                                                                         |
| `R5_BUILD_CACHE`             | 覆盖构建缓存；Windows 默认 `%USERPROFILE%\.cache\r5b\<项目摘要>` 短路径，其他平台默认 `native/target/bun-static` |
| `R5_BUILD_NINJA`             | 指定固定版本 Ninja 的位置                                                                                        |
| `WINDOWS_SYSROOT`            | 交叉编译 Windows 用的 MSVC SDK/CRT 根（上游按 SDK 10.0.26100 / CRT 14.44 验证）                                  |
| `R5_BUILD_MACOS_SDK`         | 指定兼容 LLVM 21 的 macOS SDK；本机使用 26.5，27 的头文件不兼容                                                  |
| `R5_BUILD_DEPLOYMENT_TARGET` | macOS 部署目标；与上面的 SDK 配套指定                                                                            |

例如 macOS 本地单文件验证用 `bun run package --target aarch64-apple-darwin --profile debug`，输出 `dist/r5-server`。当前 pin 下这条命令已实跑通过（151.36s，产物 363613176 B，SHA-256 `75a8e596…03c5`，入口 `/$bunfs/root/app.js` + worker `/$bunfs/root/worker.js`）；但 `otool -L` 显示这个 **debug 产物依赖 Homebrew LLVM 21 的 `libclang_rt.ubsan_osx_dynamic.dylib`（非系统库），不满足依赖闭包，不能当可分发产物**。

Windows x64 release 已在真机实跑通过（2026-09-18，Windows 11 Pro / Ryzen 7 9700X）：产物 `dist/r5-server.exe`，**110154240 B**，SHA-256 `a2e54758…fee5`，图载荷摘要 `c5b1b7f6…29e5`，入口 `B:/~BUN/root/app.js` + worker `B:/~BUN/root/worker.js`。`llvm-objdump -p` 的导入表只有系统 DLL（`kernel32`/`d3d11`/`dcomp`/`dwrite`/`icuuc` 等），**不需要 VC++ 运行库，也不依赖相邻 Bun 或 JS**。冒烟把 exe 单独复制成带中文与空格的 `单文件 面板.exe`，`PATH` 只留 Windows 自带目录（不含 Bun / cargo / Git / LLVM / Python）启动，窗口完整渲染、内嵌 JS 与 worker 落下了数据根。构建机与目标同为 `x86_64-pc-windows-msvc` 时**不需要 `R5_BUILD_BASE`**；序列化器由固定提交现场构建（`--revision` = `1.4.0-debug+34cbb9a40`）。细节与踩坑见 [docs/solid-gpui-notes.md](docs/solid-gpui-notes.md)。

上游仍把这套静态打包标为实验性，且 CI 不验证静态应用包与各目标资格；目标状态表见 `vendor/solid-gpui/docs/distribution.md`。

日常开发用 `bun run dev`（`R5F_DEV=1` 开模拟）；宿主与绑定由 `bun run generate` 单独准备，`bun run preview` 用已构建宿主运行已构建 bundle。`src/generated/native.ts`、`src/routeTree.gen.ts` 自动生成；中间 JS 在 `native/target/bundles`，不进入发布目录。

PowerShell 5.1 提示符中的命令逐条执行，不粘贴 `&&`；package scripts 内的 `&&` 由 Bun shell 执行。若缺少 `gpui-kit/crates/component/Cargo.toml`，先补齐递归子模块，而不是反复安装 Bun 或运行 Cargo。

当前 solid-gpui pin 为 `f3f8590b`（统一 Vite 工具链与公共打包 API）。静态内嵌由上一节的 `bun run package` 通过上游公共打包器完成（实验性，资格见上游分发文档）；**旧 pin `e5448f62` 的单文件构建与验收记录只属于旧提交**，迁移后的实际产物与验收范围见 [docs/solid-gpui-notes.md](docs/solid-gpui-notes.md)。

平台与产品取舍：

- 应用线程由上游 runner 管理：Windows 默认预留 16 MiB 栈，可用 `SOLID_GPUI_APP_STACK_BYTES` 指定字节数；macOS 保持 AppKit 所需的主线程。本面板过去只验证过 Windows 的 256 MiB，升级后的 16 MiB 仍需在目标 Windows 环境做压力验证，不能把上游示例通过当作本面板通过。
- `.SystemUIFont` 的 Windows 字体解析已由上游修复，宿主不再覆盖成指定字族。
- 保留 `motion::set(Reduced)` 是运维面板的产品取舍，不再声称 `Button` / `TabBar` 必崩；首帧配置通过 `ComponentHost::with_initialize` 完成。
- 占剩余空间的容器（外壳内容区、页面里靠 `flexGrow` 撑开的列）必须同时给出零初始尺寸（横向 `width: 0`、纵向 `height: 0`），否则布局引擎会先按内容测一遍整棵子树，长页面滚动会明显变卡。[实测](docs/solid-gpui-notes.md#已修复高内容页面滚动卡顿用户已于-2026-09-16-确认)

开发的 stdio 渲染器随宿主退出；发布版的界面 VM 在宿主进程内。两种方式都不得在关闭 GUI 时回收独立的游戏进程与日志守护。

提交前跑完整闸门（oxlint 规则 + 类型诊断 + oxfmt 格式，`denyWarnings` 打开，有 warning 也算不过）：

```powershell
bun run check                  # 完整闸门：typecheck + lint + fmt:check
bun run lint:fix               # 应用可自动修复的规则
bun run fmt                    # 写回格式
```

规则不适用时在 `.oxlintrc.json` 里显式关闭并写清原因，不要在源码里散落行内 `oxlint-disable`。

领域词汇见 [CONTEXT.md](CONTEXT.md)，实现参考见下文，设计与工单见 `.scratch/fleet-ops/`，仓库约定见 [AGENTS.md](AGENTS.md)。

## 模块地图（`src/`）

| 文件                            | 职责                                                                       |
| ------------------------------- | -------------------------------------------------------------------------- |
| `worker.ts` / `worker-entry.ts` | 内部后台操作分发、参数解析及完整退出码回传；不是公共 CLI                   |
| `commands.ts`                   | 实例生命周期、主机配置与游戏管理实现；启动参数构造、控制通道客户端         |
| `state.ts`                      | 实例、模板、选择指针与历史记录；旧数据迁移、跨进程串行提交、原子文件替换   |
| `versions.ts`                   | 版本目录发现、备份、切换                                                   |
| `win.ts`                        | Windows 探测与动作：进程、端口、防火墙、页面文件、Defender、计划任务、电源 |
| `tap.ts`                        | `__logd` 日志守护：管道、日志文件、控制口；日志尾部/增量读（水位线）       |
| `inspect.ts`                    | 详情、体检、主机能力与健康数据采集                                         |
| `settings-fields.ts`            | 设置项声明与校验的唯一来源，供面板与业务层共用                             |
| `panel.ts`                      | 面板稳定 API：实例生命周期、模板、日志、玩家、公告、健康、封禁             |
| `catalog.ts`                    | 从版本目录读真实清单：地图名、playlist、模式目录（按家族分组）             |
| `cfg.ts`                        | 读/校验/行级重写引擎 cfg（`shell-quote` 解析）                             |
| `serverinfo.ts`                 | 日志摘要与 status 头部解析                                                 |
| `app.tsx`                       | GUI 入口；开发选择 stdio，发行版选择内嵌传输                               |
| `paths.ts`                      | 解析宿主声明的程序目录；不混用数据目录或 Bun 安装目录                      |
| `instances.ts`                  | 实例工作副本、端口族与启动排他锁                                           |
| `releases.ts`                   | 官方文件名版本发现、下载、校验、解压与原子安装                             |
| `mode-templates.ts`             | 源码验证过的玩法参数及生效时机                                             |
| `telemetry.ts`                  | 实际采样与本地历史曲线                                                     |

界面入口 `src/app.tsx`、路由、组件与共享业务代码都属于同一个 TypeScript 项目；`native/` 是原生宿主（Rust）。`scripts/`、Vite 与 Rust 工具链配置都在根目录，不再有独立桌面工作区。

## 不变量（改代码时必须保持）

1. **面板值优先于引擎 cfg**：启动前同步已存在的 cvar 行，不新增注入命令。
2. **一次声明，处处一致**：设置项只在 `settings-fields.ts` 声明；面板与后台任务不得各写一套校验。
3. **不虚构引擎能力**：命令/参数必须有实测或 `server.dll` 证据；不支持的能力写进文档并标注未验证。
4. **输出如实**：静默、未验证、猜测都要显式标注。
5. **面板说人话，不泄露标识**：设置项不显示内部 cvar 名；UUID 不显示全量，运行编号只显示前 8 位。pid、端口和日志/名单路径属于运维必需信息，可以显示。引擎日志与 `banlist.json` 原文保留原样供排障。
6. **Windows 脚本 ASCII**：`*.bat`/`*.ps1` 内容保持 ASCII（中文 Windows 的 ANSI 解析会毁 UTF-8 无 BOM）。
7. **无 `any`**：`unknown` + 类型守卫；静态映射用 `Record`；已发布契约用具名类型。
8. **共享版本只读**：运行与用户修改全部落在实例自己的工作副本；换版本采用暂存与原子交换。
9. **不新增公网管理面**：控制通道只回环；远程运维走 SSH/私网隧道（另议）。
10. **输入态优先**：控制台、对话框与设置项收集文本时，可打印字符属于输入组件，不得被全局快捷键截走。

## 引擎事实（有证据，可引用）

- 启动契约：`-dedicated -multiple -port N +hostport N +s2sPort N+1 +clientport N-10`，以及服务器名、可见性、认证、玩法和地图等参数；环境 `VPROJECT=1`、`FROM_R5F_LAUNCHER=1` 必需。
- 测量：常驻约 3.16 GB、私有提交约 6.46 GB、每实例 ~15–20 线程；换图约 1 核 × 20 s。
- 命令/用法（实测）：`kick "<userid>"`（**不带引号无效**）、`spawnbots <count>`、`sv_addbot <name> <teamid>`、`help <cvarname>`、`convar_findByFlags <string>`、`bridge_setmode <playlist> <map>`、`bridge_chat_announce`、`playlist_override_set <var> <value>`、`banlist_reload`、`changelevel <map>`、`status`。
- 不存在（实测报错）：`say`、`say_team`、`chat_announce`、`mute`、`find`、`cvarlist`、`mp_timelimit`。
- 级别：`Native(E)/(F)` **不是**错误级别（`Native(E)` 里有正常行）；判级别按文件与词。
- 外发：1v1 对战统计 POST 到 `https://play.r5flowstate.org/stats/1v1/ingest`（`fs_stats_url`，置空即关闭）；Spire 匹配/封禁走 `spire_matchmaking_hostname`；`-offline` 关闭匹配。
- Spire 上报（实测日志 + 主服接口）：每 `spire_host_update_interval`（默认 5 s）POST `https://play.r5flowstate.org/spire/hosts/publish`，body = `name` `description` `hidden` `map` `playlist` `ip` `port` `key` `checksum` `version` `numPlayers` `maxPlayers` `timeStamp` `password`。
- 上架条件（实测）：`ip` 正确（`+hostip <公网IP>[:端口]`，引擎在 NAT 主机上自测为 `[::1]:0`，`net_public_adr` 无效；**面板一律传 `ip:端口`** —— 实测只写 IP 时对外公布的端口不对）+ **publish 从主机自己的公网 IP 出去**（主机上跑代理/VPN 会改出口 IP，主服照样判不可达；实测加直连规则后立即上架）+ 两道门放行 UDP。主服会 UDP 探测该 `ip:port`（`pktmon` 抓包可见双向包），探测不过即回 `{"success":false,"error":"Unable to communicate, please forward your ports and check if the server is publicly accessible."}` —— 主服文案，引擎原样打印（二进制里搜不到，`rate limit exceeded` 同理）。
- 列表查询（实测）：`POST /spire/hosts`，body `{"version":"R5FlowstateSDK002"}` → `{servers:[{ip,port,name,numPlayers,map,playlist,key,hidden,hasPassword,maxPlayers,description,checksum,allowedMods,requiredMods,modsProfile}],players,capacity}`；空 body 回 `{"error":"Missing required fields.","success":false}`。官方 `r5flowstate.org/host/`：探测不过的服不会出现在列表。相关 cvar：`hostip`、`hostport`（cfg 默认 37015）、`clientport` 37005、`s2sPort` 37016、`spire_showdebuginfo`（1 = 打印请求/回包）、`_sdk_apply_launch_convars`（`+cvar` 启动参数压回 cfg 之上）。
- 日志含运行期密钥（`Installed NetKey: '…'`）→ 分享日志前注意。
