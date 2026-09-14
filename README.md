# r5-server —— R5Flowstate 专用服务器管理目录

这个目录是服务器的**总目录**：CLI 本体、状态文件、日志、备份，以及一个子目录一个版本的服务端。

```
r5-server\
├─ r5-server.exe            CLI（Bun 编译的单文件，免运行时）
├─ r5-server.json           状态：当前版本 / 启动设置 / 运行中实例 / 操作历史
├─ start_dedi.bat           兜底脚本：不依赖 CLI，直接按默认参数拉起服务端
├─ logs\                    每个实例一份控制台日志（托管控制台输出）
├─ backups\                 升级前的运维配置备份（按时间戳）
└─ r5f-dedi-1.0.11\         一个版本 = 一个目录（下面放 r5f-dedi-1.0.13 …）
   ├─ r5apex_ds.exe         三件套，缺一不可
   ├─ server.dll
   ├─ loader.dll
   ├─ platform\ paks\ vpk\ maps\ mods\ cfg\ audio\ r2\
   └─ ...
```

> 目录名随便叫什么都行，CLI 只要求它同时含 `r5apex_ds.exe` + `server.dll` + `loader.dll`；
> 名字里带 `1.0.13` 这种版本号时，`list`/`upgrade` 会按版本号排序。
> 本目录下 `.exe` 之外的脚本/文档均不含业务数据，删掉不影响服务端运行。

---

## 一、首次安装

### 1. 准备机器（一次性，需要管理员）

```powershell
# 交互面板：直接双击 r5-server.exe（或在终端执行）
.\r5-server.exe

# 或者命令行一次配好：防火墙 UDP / 页面文件 / Defender 排除 / 登录自启
.\r5-server.exe setup --ports 37015 --dry-run     # 先预演看要改什么
.\r5-server.exe setup --ports 37015               # 真正执行（会弹 UAC 提权）
```

`setup` 做四件事，可重复执行、幂等：

| 动作           | 说明                                                         |
| -------------- | ------------------------------------------------------------ |
| Windows 防火墙 | 每个端口一条入站 UDP 规则（默认 37015）                      |
| 页面文件       | 固定大小；8 GB 内存机器必须，否则换图会卡                    |
| Defender 排除  | 排除本目录与 `r5apex_ds.exe`（注入式 `loader.dll` 易被误杀） |
| 登录自启       | 计划任务「R5F Dedicated Server」，登录时拉起服务端           |

> **云防火墙也要开**：腾讯云轻量控制台 → 防火墙 → 放行同样的 **UDP** 端口。
> 云防火墙和 Windows 防火墙是两道独立的门，必须都开，否则外网连不上。

### 2. 放入服务端内容

把解压出来的 `r5f-dedi-x.y.z` 整个目录放进本目录：

```
r5-server\r5f-dedi-1.0.11\   ← 直接拷进来即可
```

放好后 `list` 就能看到它。运行 `doctor` 可以体检：

```powershell
.\r5-server.exe list
.\r5-server.exe doctor
```

### 3. 选择版本并启动

```powershell
.\r5-server.exe use r5f-dedi-1.0.11      # 记下来，以后 start 都用它
.\r5-server.exe start                     # 未选版本时会提示你选
```

首次启动会自动：加载地图 → 绑定 UDP 端口 → 把日志写进 `logs\`。
大约 10–30 秒后 `status` 里能看到「运行中」。

### 4. 让玩家进来

- 玩家装 R5Flowstate launcher
- 服务器浏览器里找你的服（`visibility=2` 公开时），或直接用 IP：
  `connect <服务器公网IP>:37015`

---

## 二、日常使用

```powershell
.\r5-server.exe                # 打开交互面板（推荐）
```

面板里：`s` 启动 · `x` 停止 · `R` 重启 · `↑↓/Enter` 选版本 · `U` 升级 ·
`t` 详情页 · `d` 体检页 · `e` 主机配置 · `g` 游戏设置 · `l` 日志跟随开关 · `PgUp/PgDn` 翻日志 · `Esc` 返回 · `q` 退出

面板布局（内容区自动撑满终端高度，可滚动）：

```
┌ R5Flowstate 服务器管理 ───────────────────────────┐  头部：根目录 / 当前版本 / 默认启动参数
│ 当前版本 r5f-dedi-1.0.13  game v3.0.72.12        │
│ 默认启动 UDP 37015 · 地图 … · 可见性 离线          │
├── 版本（2）─────┬── 实例 ─────────────────────────┤  左：本机所有版本（↑↓ 选，回车切换）
│ ❯ r5f-dedi-1.0.13 │ 状态 运行中                  │  右：进程/地图/人数/CPU/内存/端口/日志
├── 日志 ─────────┴───────────────────────────────┤  日志区：占满剩余高度
│ [3.096] Native(F):Mounted vpk file: …            │  PgUp/PgDn 回溯 · End 回到最新 · l 暂停跟随
└──────────────────────────────────────────────────┘
s 启动 · x 停止 · t 详情 · d 体检 · e 主机配置 · q 退出
```

- **详情页（`t`）**：版本/启动参数、进程指标、日志状态、主机状态、最近操作，`↑↓`/`PgUp`/`PgDn` 滚动，`r` 刷新，`Esc` 返回。
- **体检页（`d`）**：同样的主机检查，底部列出待处理项（防火墙缺失、页面文件偏小、Defender 未排除、未设自启、磁盘不足……）。
- **主机配置页（`e`）**：能力清单，`空格` 勾选、`回车` 应用（会调用 `setup`，需要管理员，弹 UAC）：

```
❯ [x] Windows 防火墙放行 UDP 37015
      规则「R5F dedi UDP 37015」已存在
  [ ] 页面文件固定大小
      当前：系统托管（8 GB 内存建议 8192/16384）
  [ ] Defender 排除服务器目录
  [ ] 开机自启（登录时启动）
  [x] 电源计划设为高性能
```

未勾选的项会被显式跳过（`setup --no-firewall --no-pagefile --no-defender --no-task --no-power`）。
开机自启已经并入这一页，不再占用主界面按键。

### 游戏设置页（`g`）：改完就是最终生效值

```
┌ 游戏设置（Esc 返回）─────────────────────────────────────────────────────────┐
│ 启动设置   10 项 · 每项都是启动参数，改完需重启服务器 · 清单来自当前版本        │
│ ❯ 服务器名          R5F Server                                              │
│   地图              mp_rr_district        已修改                             │
│   模式（playlist）  (空 = 由玩家选择)                                         │
│   可见性            0  离线                                                  │
│   在线认证          0  关闭                                                  │
│   端口（UDP）       37193                 已修改                             │
│   密码              (未设置)                                                 │
│   命令配额          256 string/s                                             │
│   脚本配额          128 script/s                                             │
│   附加参数          (空)                                                     │
│   显示在玩家看到的服务器列表与控制台标题里。                                   │
│   默认值：R5F Server   ·   重启服务器后生效                                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

编辑走**居中对话框**（`回车` 打开）：文本/数字是输入框（带实时校验），
枚举和清单（地图/模式）是候选列表，末项总是「（手动输入…）」以便填清单外的值。

```
        ╭────────────────────────────────────────────────────────────╮
        │ 编辑：服务器名                                              │
        │ 我的服务器▎                                                 │
        │ 取值：1–60 个字符，允许中文                                  │
        │ 重启服务器后生效                                            │
        │ 启动时同步到 platform/cfg/system/autoexec_server.cfg 第 6 行 │
        │ 回车 保存 · 退格 删除 · Esc 取消                             │
        ╰────────────────────────────────────────────────────────────╯
```

- 字段清单、默认值、取值说明都来自 `src/settings-fields.ts` 一张声明式表，
  **CLI 与面板共用同一份校验**：`r5-server settings --port 70000` 与面板里输入 70000
  得到同样的拒绝理由，不存在「一边能存一边不能存」。
- 地图/模式候选**读当前版本的真实清单**（不是硬编码）：`platform/r5f_map_names.txt`
  用 `dotenv` 解析，`platform/playlists_r5_patch.txt` 用 `keyvalues-tools` 解析
  Valve KeyValues（Source 2 变体，裸值 + `//` 注释）。
- **cfg 不会覆盖面板值**：`platform/cfg/system/autoexec_server.cfg` 在启动参数*之后*
  执行，本来就写着 `hostname` / `spire_host_visibility`。启动前会把这些行同步成面板值
  （只改已存在的行、保留缩进与注释），日志区会打印同步了哪些行：

```
  ▶ 启动服务器   (r5-server start)
  已同步 platform/cfg/system/autoexec_server.cfg: spire_host_visibility "2" → "0"（否则 cfg 会覆盖面板设置）
```

设置页里对这类字段显示 `cfg≠` 与具体行号，编辑对话框里也会提示启动时会写哪一行。

### 在线玩家与控制台（RCON 等效能力，不需要开 RCON）

面板里按 `p` 打开玩家页，按 `:` 打开控制台命令行。命令行**在真实服务器控制台上执行**，
输出直接进日志区；玩家页的 `status` 也是同一通道取的。

```
┌ 在线玩家 ─────────────────────────────────────────────────────────┐
│  2 人在线 · 数据来自服务器控制台 status                            │
│  hostname: R5F Server  ·  version : 2.0.0.1/2001  ·  players : 2 … │
│  #   userid  id64                  ping  状态        名字          │
│  ❯   1       1001234567890123      45    active      Alpha        │
│      2       1009876543210987      88    active      Beta 玩家     │
│  k 踢出 · b 封禁 · u 解封 · r 刷新 · : 控制台 · Esc 返回            │
└──────────────────────────────────────────────────────────────────┘
```

```powershell
.\r5-server.exe players                      # 在线玩家（解析 status，可 --json）
.\r5-server.exe console status               # 在跑着的服务器上执行任意控制台命令
.\r5-server.exe console changelevel mp_rr_canyonlands_hu   # 立即换图（不重启、不掉人）
.\r5-server.exe kick 1                       # 踢出 userid=1
.\r5-server.exe ban 1                        # 封禁（写入引擎的 banlist.json）
.\r5-server.exe unban 1009876543210987       # 按 id64 解封
```

面板里可用 `:` 直接跑同样能力：`changelevel <地图>`、`say <公告>`、`sv_password <pw>`、
`kick "<userid>"`、`ban <userid>`、`unban <id64>`、`banlist_reload`、任意 cvar 热改。

**为什么不开引擎自带的 RCON**：本构建的 RCON 是自定义协议（AES-128-GCM 帧 + 会话/序列号），
现成客户端连不上；而引擎自己的 `rcon_server.cfg` 启动时会执行并把 `sv_rcon_password` 覆盖成空，
即默认关闭。我们改用它**同一条控制台权限通道**——托管控制台的输入管道 `R5F_CONSOLE_IN`
（启动时的 `R5F_HOSTED_CONSOLE` 协议），由日志守护进程代理：

```
面板/CLI ──(127.0.0.1:临时端口 + 随机口令)──► __logd ──(R5F_CONSOLE_IN 管道)──► 引擎控制台
```

- 全程回环：不新增任何公网端口，不需要密码，不引入新的 DDoS 面（对应之前"RCON 留空/只回环"的结论）。
- 控制端口是**临时端口**，令牌每次启动随机生成，存在 `r5-server.json` 的 `runtime.ctlPort/ctlToken`。
- 引擎控制台输出本来就经 `R5F_HOSTED_CONSOLE` 回到日志文件，所以命令的输出在日志区直接可见。

**动作输出不接管屏幕**：面板里按 `s`/`x`/`R`/`U`/`t`… 触发的命令会在后台子进程里执行，
输出直接写进日志区（与游戏日志同屏、分色显示）：

```
│ [6.681] Native(S):Script compiler finished in 1.777426 seconds        ← 游戏日志（原色）
│ ▶ 切换版本到 r5f-dedi-1.0.13   (r5-server use r5f-dedi-1.0.13)        ← 动作标题（绿色加粗）
│ 当前版本已设为 r5f-dedi-1.0.13                                        ← 命令输出（青色）
│ ✔ 切换版本到 r5f-dedi-1.0.13 完成                                     ← 成功（绿色）
```

失败时最后一行是红色的 `✘ 动作名 退出码 N`；长动作（启动/升级）期间日志区标题会显示 `⏳ … 运行中…`。
日志区用 `PgUp/PgDn` 回溯，`End` 回到最新，`l` 暂停/恢复跟随。

命令行等价写法：

```powershell
.\r5-server.exe status                 # 人数 / 地图 / CPU / 帧耗时 / 内存 / 端口 / 日志 / 自启
.\r5-server.exe status --watch         # 每 3 秒刷新
.\r5-server.exe logs --lines 50        # 看最近的日志
.\r5-server.exe logs -f                # 实时跟随（Ctrl+C 退出）
.\r5-server.exe stop                   # 停服（连日志守护一起停）
.\r5-server.exe restart                # 重启
```

### 日志是怎么来的

服务端启动时，CLI 会先拉起一个**托管控制台**（命名管道，用的是 R5Flowstate
官方 launcher 同一套协议：`R5F_HOSTED_CONSOLE` / `R5F_CONSOLE_PIPE`），引擎把
控制台输出写进管道，守护进程落盘成 `logs\<版本>-<端口>.log`。
所以：**关掉终端不影响服务器和日志**，日志文件可以随时 `logs -f` 追。

不想要这套（例如你更习惯看引擎自己的窗口，或想用窗口标题里的人数和 CPU 指标）：

```powershell
.\r5-server.exe start --no-host
```

### 改启动参数

启动参数持久保存在 `r5-server.json`，用 `settings` 改：

```powershell
.\r5-server.exe settings --port 37016 --map mp_rr_district --visibility 1
.\r5-server.exe settings                      # 看当前设置
```

常用项：

| 选项           | 含义                                                                       |
| -------------- | -------------------------------------------------------------------------- |
| `--port`       | UDP 端口，一个实例一个                                                     |
| `--map`        | 启动地图 stem，见 `platform\r5f_map_names.txt`                             |
| `--playlist`   | 启动即进入某模式（留空=等玩家选），id 见 `platform\playlists_r5_patch.txt` |
| `--visibility` | 0=离线不上链 1=隐藏(凭 token) 2=公开列表                                   |
| `--auth`       | `sv_onlineAuthMode`：0 关 / 1 强制 join token / 2 有就校验（公开服建议 1） |
| `--password`   | 服务器密码，客户端要一致                                                   |
| `--hostname`   | 服务器名（空名会被主服务器拒）                                             |

单次覆盖（不写回配置）：`.\r5-server.exe start --port 37017 --map mp_rr_aqueduct`

---

## 三、未来更新（升级到新版本）

设计目标：**换版本不动运维配置，出问题能退回。**

### 步骤

1. 把新版本解压到本目录（与旧版本并列）：
   ```
   r5-server\r5f-dedi-1.0.13\   ← 新
   r5-server\r5f-dedi-1.0.11\   ← 旧（保留）
   ```
2. 执行升级：

   ```powershell
   .\r5-server.exe upgrade               # 交互：列出版本，选更新的那个
   .\r5-server.exe upgrade --to r5f-dedi-1.0.13 --yes
   ```

3. CLI 依次做：
   - 校验新版本三件套齐全；
   - 把**当前版本**的运维文件备份到 `backups\<时间戳>\<版本>\`；
   - 按迁移策略把运维改动复制到新版本目录；
   - 把 `r5-server.json` 的 `current` 指向新版本；
   - 提示 `restart` 生效。

### 迁移策略（`--carry`）

| 取值             | 迁移内容                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`（默认） | `mods\` 以外的运维文件：`platform\playlists_r5_patch.txt`、`platform\r5f_map_names.txt`、`platform\r5f_wip_maps.txt`、`platform\cfg\**`（`autoexec_server*.cfg`、`game.cfg`、`tools\rcon_*.cfg`） |
| `all`            | 上面这些 **+ `mods\` 整个目录**                                                                                                                                                                   |
| `none`           | 不迁移，只切版本（想用新版本自带配置时）                                                                                                                                                          |

### 升级后

```powershell
.\r5-server.exe restart        # 或 stop 后 start
.\r5-server.exe status
.\r5-server.exe logs -f        # 确认新版本正常起图
```

### 回退

旧版本目录没有被删除，`use` 回去再 `restart` 即可：

```powershell
.\r5-server.exe use r5f-dedi-1.0.11
.\r5-server.exe restart
```

配置想还原：从 `backups\<时间戳>\` 里拷回对应文件。确认新版本稳定后，旧版本目录和
备份可以自行删除（没被 CLI 自动清理）。

### 一句话版本流程

```
解压新版本 → upgrade（自动备份+迁移+切换）→ restart → status/logs 确认 → 稳了再删旧目录
```

### 升级 CLI 本体（`r5-server.exe`）

托管控制台运行时，日志守护进程就是 `r5-server.exe __logd`，会锁住这个文件。所以
**替换 CLI 前先停服**：

```powershell
.\r5-server.exe stop --all     # 停服 + 停日志守护
# 再把新的 r5-server.exe 覆盖进来
.\r5-server.exe status
```

（只升级服务端版本目录时不需要停——那些文件在别处，只要不在运行。）

---

## 四、常见问题

| 现象                                    | 处理                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `start` 30 秒内报「没有出现服务端进程」 | `doctor` 看三件套 / Defender 排除；确认 `r5apex_ds.exe` `server.dll` `loader.dll` 都在版本目录根 |
| `start` 报「UDP xxx 已被占用」          | 别的实例在跑：`status` 看 pid，或 `stop --all`；也可换端口                                       |
| 玩家连不上                              | 云防火墙 + Windows 防火墙都要放 UDP 端口；`status` 里确认端口绑定                                |
| 日志文件一直空                          | 本次是 `--no-host` 启动的（日志只在引擎窗口）；不加该参数重启即可                                |
| 内存吃紧（8 GB 机器）                   | `setup` 已把页面文件设成固定 8 GB；能加内存到 16 GB 更稳（单实例提交约 6.5 GB）                  |
| 换图时卡                                | 同上，页面文件太小或机械盘；内容盘建议 NVMe                                                      |
| 开机没自启                              | `autostart status` 看状态；登录触发的任务需要自动登录（`netplwiz`）或重启后登录一次              |
| 想限定端口来源                          | 云防火墙里把 UDP 规则改成只允许你的玩家网段                                                      |

### 多开实例

同一版本目录可以跑多个实例（实测可行），每个实例一个端口：

```powershell
.\r5-server.exe start --port 37015 --force
.\r5-server.exe start --port 37016 --force
```

内存按 **每实例 6.5 GB 提交 / 3.2 GB 工作集** 预留；CPU 空闲约 0.1 核，开局加载约 1 核 20 秒。

---

## 五、开发者（本目录源码）

```
src\
├─ cli.tsx        入口：commander 参数解析 + Ink 面板
├─ tui.tsx        Ink 面板（主界面 + 详情/体检/主机配置三个页面）
├─ keys.ts         面板按键路由（纯函数，可单独验证）
├─ inspect.ts      异步数据采集（详情/体检/能力清单）
├─ serverinfo.ts   版本描述与日志/标题解析
├─ settings-fields.ts  设置项声明表（渲染 + 校验，CLI/面板共用）
├─ settings-edit.ts    设置编辑状态机（纯函数）
├─ catalog.ts      地图/模式清单（dotenv + keyvalues-tools）
├─ （控制台通道在 tap.ts 的 __logd 与 commands.ts 的 console/players 里）
├─ cfg.ts          引擎 cfg 读取与 cvar 同步（shell-quote）
├─ commands.ts    list/use/start/stop/status/logs/autostart/upgrade/setup/settings/doctor
├─ state.ts       r5-server.json 读写
├─ versions.ts    版本发现 / 校验 / 排序 / 迁移清单
├─ tap.ts         托管控制台：命名管道 + 日志守护 + 日志读取
├─ win.ts         Windows：FFI(控制台 UTF-8/ANSI)、提权、PowerShell、进程查询
├─ ui.ts          非面板命令的终端输出
├─ util.ts        共用小工具：读文件、收窄 unknown JSON
└─ stubs\         react-devtools-core 空实现（Ink 可选依赖，见 tsconfig paths）
```

```powershell
bun run src/cli.tsx <命令>      # 开发期直接跑源码（不要反复打包）
bun run build                  # 需要发版时才编译成 r5-server.exe
```

### 提交前检查

oxlint（规则）与 oxfmt（格式）是本仓库唯一的检查与格式化工具，配置在
`.oxlintrc.json` / `.oxfmtrc.jsonc`，缩进与换行同时写进 `.editorconfig` 供编辑器读取。

```powershell
bun run check        # 完整闸门：类型 + 规则 + 格式，全绿才提交
bun run lint         # 只跑规则（含类型感知规则，如 no-floating-promises）
bun run lint:fix     # 应用可自动修复的规则
bun run typecheck    # 规则 + TypeScript 编译诊断（等价 tsc --noEmit，无需额外依赖）
bun run fmt          # 写回格式
bun run fmt:check    # 只检查不改动（CI / 提交前用）
```

`bun run check` 会在任何一条不过时以非零码退出：规则里 correctness / suspicious 是
error，perf 是 warning，且 `denyWarnings` 打开 —— 有 warning 也算不过。

已知的刻意取舍（改规则前先读这里）：

| 规则                                        | 状态 | 原因                                                      |
| ------------------------------------------- | ---- | --------------------------------------------------------- |
| `eslint/no-await-in-loop`                   | 关闭 | 本 CLI 大量「轮询引擎就绪 / 顺序下发命令」，并发反而错    |
| `oxfmt.ignorePatterns` 里的 `r5f-dedi-*/**` | 忽略 | 版本目录只读（`CONTEXT.md` 不变量 7），含引擎自带 md/json |

如果某条规则确实不适用，在 `.oxlintrc.json` 里显式关闭并写清原因 —— 不要用行内
`oxlint-disable` 散落在源码里。
