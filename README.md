# r5-server —— R5Flowstate 服务器管理面板

管理 **R5Flowstate 专用服务端（`r5f-dedi-*`）** 的 Windows 面板程序。一个 `r5-server.exe` 同时是命令行工具和交互式面板，覆盖服务端从装好到日常运营的整条链路：版本切换、启动/停止/重启、升级与回退、主机配置、托管控制台日志、在线玩家与审核、模式与公告、环境体检。

- **面向谁**：自建 R5Flowstate 专用服的服主与运维。单机部署，不需要公网管理面。
- **不做什么**：不是游戏本体，不含任何游戏内容（`r5apex_ds.exe` / `server.dll` / `loader.dll` / paks 都要你自己放入）；不改引擎行为，不理解成为 RCON 客户端。

> 与 Respawn Entertainment / Electronic Arts / R5Flowstate 官方无隶属关系，为第三方运维工具。

## 设计取舍

| 取舍                 | 做法                                                                               | 为什么                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **不开管理端口**     | 控制通道只监听 `127.0.0.1` 的临时端口 + 每次启动随机令牌                           | 本构建的 RCON 是自定义协议（AES-128-GCM），现成客户端连不上，且 `rcon_server.cfg` 启动时会把 `sv_rcon_password` 覆盖成空。改用引擎自带的托管控制台输入管道，等价能力，零新增 DDoS 面 |
| **面板值优先**       | 启动前把面板设置写回**已存在**的 cvar 行（`autoexec_server.cfg` 等）               | 引擎在启动参数*之后*执行 cfg，否则 cfg 会静默覆盖你刚设的值                                                                                                                          |
| **版本目录尽量只读** | 只写引擎自己会写的文件，和用户明确要编辑的 `chat_announcements.csv`                | 换版本时可整体丢弃，不产生需要迁移的散落改动                                                                                                                                         |
| **静默 ≠ 成功**      | 引擎回执分 `success` / `unknown` / `usage` / `silent` 四类，逐类如实汇报           | 托管控制台没有 RCON 状态码，唯一可信信号是引擎自己的输出；"没回话"不能算"执行成功"                                                                                                   |
| **不虚构引擎能力**   | 命令/参数必须有实测或 `server.dll` 证据；不支持的写进文档并标注                    | 见下方[已知边界](#已知边界)                                                                                                                                                          |
| **依赖等满 24 小时** | `bunfig.toml` 里 `install.minimumReleaseAge = 86400`，安装时跳过发布不满一天的版本 | 投毒包一般在发布后几小时内被发现并撤下；面板能起进程、能提权，装错一次等于交出宿主机                                                                                                 |

## 环境要求

| 项         | 要求                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| 系统       | Windows x64（Windows Server 2022 验证过；进程/端口/防火墙/提权全部走 PowerShell 与 Win32 API，无 Linux 路径） |
| 服务端内容 | 一个 `r5f-dedi-x.y.z` 目录，根目录须同时含 `r5apex_ds.exe` + `server.dll` + `loader.dll`                      |
| 内存       | 每实例预留 **3.2 GB 工作集 / 6.5 GB 提交**；8 GB 机器必须设固定页面文件（`setup` 会做）                       |
| 运行面板   | 无需运行时，`r5-server.exe` 是 Bun 编译的单文件                                                               |
| 从源码构建 | [Bun](https://bun.sh)（见[开发](#开发)）                                                                      |

## 快速开始

```powershell
# 1. 把解压好的服务端目录放进面板所在目录（名字随意，三件套齐全即可）
#    D:\r5-server\r5f-dedi-1.0.13\{r5apex_ds.exe, server.dll, loader.dll, ...}

# 2. 主机一次性配置：防火墙 / 页面文件 / Defender 排除 / 登录自启（会弹 UAC）
.\r5-server.exe setup --ports 37015 --dry-run    # 先看要改什么
.\r5-server.exe setup --ports 37015

# 3. 选版本并启动
.\r5-server.exe list
.\r5-server.exe use r5f-dedi-1.0.13
.\r5-server.exe start

# 4. 打开面板
.\r5-server.exe
```

启动后 10–30 秒内 `status` 会显示运行中；玩家用 R5Flowstate 启动器在服务器列表里找到它（`visibility=2`），或 `connect <公网IP>:37015`。

> **云服务器两道门都要开**：控制台的安全组/防火墙放行同样的 **UDP** 端口，与 Windows 防火墙是两套独立规则，只开一边外网连不上。

## 交互式面板

不带子命令运行 `r5-server`（TTY 下）即进入面板；非 TTY 会打印帮助。等价写法 `r5-server tui [--no-follow]`。

```
┌ R5Flowstate 服务器管理 ───────────────────────────┐  头部：根目录 / 当前版本 / 默认启动参数
├── 版本（2）─────┬── 实例 ─────────────────────────┤  左：本机所有版本（↑↓ 选，回车切换）
│ ❯ r5f-dedi-1.0.13 │ 状态 运行中                │  右：进程/地图/人数/CPU/内存/端口/日志
├── 日志 ─────────┴───────────────────────────────┤  日志区：占满剩余高度，收所有动作输出
│ [3.096] Native(F):Mounted vpk file: …            │  PgUp/PgDn 回溯 · End 回到最新 · l 暂停跟随
└──────────────────────────────────────────────────┘
```

| 页面     | 键  | 内容                                                      | 页面内按键                                                                            |
| -------- | --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 主页     | —   | 版本列表 + 实例指标 + 实时日志                            | `↑↓` 选版本 · `Enter` 切换 · `s` 启动 · `x` 停止 · `R` 重启 · `U` 升级 · `l` 跟随开关 |
| 详情     | `t` | 人数/地图/CPU/帧耗时/内存/端口/日志/自启                  | 滚动 · `r` 刷新                                                                       |
| 环境体检 | `d` | 主机检查 + 本次运行健康（`error/warning/script_warning`） | 滚动 · `r` 刷新                                                                       |
| 主机配置 | `e` | 能力清单：防火墙 / 页面文件 / Defender / 自启 / 电源计划  | `空格` 勾选 · `Enter` 应用（调 `setup`，弹 UAC）· `r` 重探                            |
| 游戏设置 | `g` | 12 项启动设置，枚举与清单走候选列表                       | `Enter` 编辑 · `r` 还原默认 · 选中模式行且有实例在跑时 `x` 热切模式                   |
| 在线玩家 | `p` | `status` 解析出的玩家表，机器人单独标记                   | `k` 踢 · `b` 封（确认框）· `u` 解封 · `+`/`-`/`c` 加减/清空机器人 · `r` 刷新          |
| 封禁名单 | `B` | 本地 `banlist.json` 内容                                  | 滚动 · `r` 重新加载（先发 `banlist_reload`）                                          |
| 公告     | `n` | `chat_announcements.csv` 行                               | `a` 新增 · `d` 删除选中 · `t` 立即广播 · `r` 重读                                     |
| 控制台   | `:` | 单行控制台命令，在真实服务器上执行，输出进日志区          | `Enter` 执行 · `Esc` 取消                                                             |

全局：`Esc` 返回主页 · `q` / `Ctrl+C` 退出。控制台或对话框打开时，所有字母键归输入，不再当快捷键。

面板动作（`s`/`x`/`R`/`U`/`t`…）都在**子进程**里跑，输出写进日志区，不接管屏幕：

```
│ [6.681] Native(S):Script compiler finished in 1.777426 seconds     ← 游戏日志（原色）
│ ▶ 切换版本到 r5f-dedi-1.0.13   (r5-server use r5f-dedi-1.0.13)     ← 动作标题
│ ✔ 切换版本到 r5f-dedi-1.0.13 完成                                   ← 成功；失败是红色 ✘ 退出码 N
```

## 命令参考

24 个可见子命令（另有隐藏的 `__logd`，由 `start` 自动拉起，不要手调）。

### 版本与实例

| 命令            | 说明                                     | 选项                                                                                                                                                                                      |
| --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`          | 列出根目录下的可用版本                   | `--fast` 跳过体积统计                                                                                                                                                                     |
| `use [dir]`     | 选择/切换当前版本                        | —                                                                                                                                                                                         |
| `start`         | 启动当前版本（未选版本时会先让你选）     | `--port` `--map` `--playlist` `--visibility` `--auth` `--password` `--hostname`（都只影响这一次，不写回配置）`--foreground` `--no-restart` `--no-host` `--force` `--detach`（默认即后台） |
| `stop`          | 停止实例（连日志守护一起）               | `--all` 停掉本目录下所有实例                                                                                                                                                              |
| `restart`       | 重启当前版本                             | —                                                                                                                                                                                         |
| `status`        | 人数/地图/CPU/帧耗时/内存/端口/日志/自启 | `--watch` 每 3 秒刷新                                                                                                                                                                     |
| `upgrade [dir]` | 备份旧配置 → 迁移 → 切换                 | `--to <dir>` `--carry none\|config\|all`（默认 `config`）`-y, --yes`                                                                                                                      |

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
| `tui`                                      | 打开交互式面板                                         | `--no-follow`                                                                                                                                            |

**退出码**：`console` / `kick` / `ban` / `unban` / `bots add` → `0` 成功或静默、`1` 命令不存在或用错、`2` 没有控制通道（没启用托管控制台）；`setup` / `autostart` → `1223` 表示用户拒绝了 UAC。

#### 1v1 模式（当前默认）

本机默认已固定成 1v1：`playlist = fs_1v1`、`map = mp_rr_arena_habitat`（都在 `r5-server.json` 里，面板"游戏设置"可改）。

- `fs_1v1` 是版本自带的 R5F 模式（`platform/playlists_r5_patch.txt`），家族 `1v1`，声明了 11 张可轮换地图（`fs_1v1_rotate_mp_rr_*`）。
- 运行中换模式/地图不用重启：`mode set fs_1v1 mp_rr_arena_phase_runner`（面板：设置页选中"模式"行后按 `x`）。它走引擎的 `bridge_setmode`，一步换 playlist + 换图。
- 模式自己的参数（装备套装 `fs_1v1_locked_set`、自定义武器 `custom_1v1_weapons_*`、轮换图开关）写在该模式的 `vars` 块里，改完 `changelevel` 或重启生效。
- 同家族还有 `fs_lgduels_1v1`（R99 上膛决斗）。
- 1v1 对战统计默认会 POST 到 `play.r5flowstate.org`；不想外发就把"1v1 数据上报"设为"关闭上报"（启动参数追加 `+fs_stats_url ""`）。

## 配置

唯一配置文件是根目录的 `r5-server.json`（写入采用临时文件 + 改名，崩溃不会截断）：

```jsonc
{
  "current": "r5f-dedi-1.0.13", // 当前生效版本目录名
  "settings": {/* 见下表 */},
  "runtime": {
    // 运行中实例，stop 后清空
    "pid": 12345,
    "port": 37015,
    "version": "r5f-dedi-1.0.13",
    "startedAt": "2026-09-14T15:28:44Z",
    "logdPid": 12300,
    "logFile": "logs\\r5f-dedi-1.0.13-37015-20260914-232844.log",
    "ctlPort": 54321,
    "ctlToken": "…",
  },
  "history": [/* 最近 50 条操作记录 */],
}
```

`settings` 的 12 个字段（`src/settings-fields.ts` 是**唯一**声明表，CLI 与面板共用同一份校验）：

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

## 开发

```powershell
bun install
bun run dev                    # 源码方式运行面板（改代码即时生效）
bun run build                  # 编译单文件 r5-server.exe（bun-windows-x64，minify）
bun update --latest            # 依赖升到最新（受下面那条 24 小时冷却期约束）
```

依赖一律取最新，但**只装发布满 24 小时**的版本：根目录 [`bunfig.toml`](bunfig.toml) 设了 `install.minimumReleaseAge = 86400`，`bun install` / `bun add` / `bun update` 都会过滤掉当天刚发布的版本，没有豁免名单。因此 `bun update --latest` 有时会**退**到上一个合规版本（比如当天刚发的 oxlint 要等满一天才装得上），第二天重跑一次即可跟上。

源码结构（`src/`）：

| 文件                 | 职责                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `cli.tsx`            | commander 入口：所有子命令注册 + 无参数时进面板                                             |
| `commands.ts`        | 命令实现：启动/停止/升级/设置/玩家/审核/公告/模式/健康；启动参数构造；控制通道客户端        |
| `tui.tsx`            | Ink 面板：8 个页面（主页/详情/体检/主机配置/游戏设置/在线玩家/封禁名单/公告）、轮询、日志区 |
| `keys.ts`            | 按键路由与状态迁移（纯函数，可单测）                                                        |
| `settings-fields.ts` | **唯一**的设置项声明表：渲染、校验、CLI、面板共用                                           |
| `settings-edit.ts`   | 设置编辑状态机（浏览/输入/选择）                                                            |
| `state.ts`           | `r5-server.json` 读写与容错                                                                 |
| `versions.ts`        | 版本发现、三件套校验、排序、升级迁移清单                                                    |
| `tap.ts`             | 托管控制台：命名管道、`__logd` 日志守护、回环控制口                                         |
| `cfg.ts`             | 引擎 cfg 读取与 cvar 同步（`shell-quote` 解析，行级重写）                                   |
| `catalog.ts`         | 从版本目录读真实清单：地图名、模式目录（按家族分组）                                        |
| `announcements.ts`   | 公告表解析/渲染/校验（`chat_announcements.csv`）                                            |
| `receipt.ts`         | 回执分类（纯函数，`success` / `unknown` / `usage` / `silent`）                              |
| `inspect.ts`         | 面板数据采集：详情、体检、主机能力、运行健康                                                |
| `serverinfo.ts`      | 版本描述与日志/`status` 头部解析                                                            |
| `ui.ts` / `util.ts`  | 终端渲染原语；共用小工具                                                                    |
| `win.ts`             | Windows 探测与动作：进程、端口、防火墙、页面文件、Defender、计划任务、电源、UAC             |
| `stubs/`             | 编译 exe 用的替身（`react-devtools-core`）                                                  |

提交前跑完整闸门（oxlint 规则 + 类型诊断 + oxfmt 格式，`denyWarnings` 打开，有 warning 也算不过）：

```powershell
bun run check                  # 完整闸门：typecheck + fmt:check
bun run lint:fix               # 应用可自动修复的规则
bun run fmt                    # 写回格式
```

规则不适用时在 `.oxlintrc.json` 里显式关闭并写清原因，不要在源码里散落行内 `oxlint-disable`。

模块职责与领域词汇见 [CONTEXT.md](CONTEXT.md)，设计与工单见 `.scratch/fleet-ops/`，仓库约定见 [AGENTS.md](AGENTS.md)。
