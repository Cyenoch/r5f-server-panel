# solid-gpui 适配与剩余问题

更新时间：2026-09-17。当前子模块 pin 为 **`e5448f62cbdde66c67d9d073609a0fab185697c3`**（Windows Support），从 `fbd73f6` 升级。下方旧十条痛点记录的是此前 `66f17e0` → `fbd73f6` 的适配。

证据按平台分别记录；**上游记录**指 SDK 自己的示例/测试，**源码分析**不等于运行验收。下方历史阶段的分发方案已由最新单文件方案取代。

## 根目录与严格单文件分发

界面源码合并在根 `src/`，原生宿主在根 `native/`，路由生成与打包在根 `scripts/`。根目录统一管理 package、依赖锁、TypeScript、Vite 与 Rust 工具链；没有独立桌面工作区。

- 删除公共 CLI、转发启动器与 stage 流程。`bun run dev` / `bun run gui` 启动真实后端开发面板，`bun run gui:dev` 显式开启模拟。默认不模拟。
- `bun run build` 默认生成 Windows x64 release `dist/r5-server.exe`：GPUI、自有宿主、Bun/JSC、GUI 与 worker 模块图静态链接为一个文件；不分发相邻 Bun/JS，不解包应用代码，不回退到磁盘源码。
- 开发继续使用外部 Bun/stdin；发行版使用内嵌传输。同一个 EXE 的内部 `--worker` 承担配置、计划任务、日志守护与模拟引擎，保留独立生命周期；不是公共命令行界面。
- `src/paths.ts` 优先使用宿主声明的程序目录，源码回退到模块 URL；数据父目录独立配置。原生入口每次重建 worker 参数与命令前缀，避免旧环境误选操作。
- worker 完成通过 `R5WX` 帧携带完整状态，原生宿主同时检查 VM 终止状态，避免把 Windows 取消码 1223 截成 8 位状态。
- JS 中间文件位于 `native/target/bundles/`。Windows 原生缓存使用用户目录下的项目独立短路径，避免 Ninja/cmd 的长路径失败；最终镜像与图验证后才原子发布到 `dist/`。
- 原生清单复用仍验证固定提交、补丁、overlay 字节、目标/档位及所有链接输入；没有修改 vendored SDK 或绕过来源检查。
- 首次构建先逐条执行 `git submodule update --init --recursive` 与 `bun install`；PowerShell 5.1 不使用粘贴的 `&&`。固定工具链与覆盖项见 README。

已完成的应用侧验证：

- Windows x64 release：在 ARM64 Windows 11 的 x64 兼容层完成根目录构建，产物已复制到本仓库 `dist/r5-server.exe`，大小 **109396992 B**；SHA-256 为 `41dd36704915c8e0125ea33d2a5cda716df814b8b78fc951e43d78862300ad5c`。镜像校验了 x64 机器类型及 `B:/~BUN/root/app.js`、`B:/~BUN/root/worker.js` 两个入口，图摘要为 `22d50d80ce9d8f877e6d51a0c454eef789f04ce27d1a39c708f124afe4f02bd9`。
- Windows 单文件迁移：只复制 EXE 并改名为含中文的文件，目录同时含空格；从 Windows 系统目录启动，PATH 仅保留系统路径，没有旁置 Bun/JS。已观察真实后端总览及正常关闭；最终产物的模拟窗口实测启动实例、关闭 GUI 后原 worker PID 8124 继续存活、重开后识别同一实例、输入 `status` 得到“引擎确认执行”与 hostname 回执、确认停止后显示 0 个运行实例且 worker 消失。测试窗口和控制进程均已退出，未停止其他实例。
- Windows 真实管道：最终 EXE 的 `__logd` 使用真实 Windows 命名管道，拒绝错误令牌、接受正确令牌，将 `status` 转发至输入管道，并将 ANSI UTF-8 与 CP936 输出解码为准确的 `你好\n旧控制台中文\n`；所属测试进程退出、管道关闭后 daemon 返回 0。客户端及占位进程是探针，不是真实游戏引擎。
- PE 普通及延迟导入表仅列 Windows 系统 DLL，没有 Bun 或 VC 运行库旁置依赖；运行验证仍发生在有开发工具的 Windows VM 中，不冒充全新系统认证。
- Windows 计划任务参数：实测 PowerShell 5.1 会拆分带引号的 `/TR`；改为直接 argv 调用 `schtasks.exe` 后保持单个命令字符串，查询不存在的任务返回实际状态 1。此项没有创建、删除或触发真实计划任务。
- macOS ARM64 debug：根目录单文件构建通过；仅复制并重命名可执行文件到含空格/中文的目录，从无关 cwd、无 Bun PATH 启动。
- macOS 模拟：界面启动实例后关闭 GUI，worker 被 PID 1 接管且继续运行；重新打开面板后可观察并停止该实例。更新后的单文件 GUI 还实测执行 `status`，界面显示“引擎确认执行”及 hostname 回执，随后停止测试实例并正常退出。未停止其他已有实例。
- macOS 内部 setup dry-run：忽略继承的错误 worker 参数；计划任务预览指向改名后的同一个文件及 `--worker start`。
- Windows 11 / PowerShell 5.1 非提权日志中转：旧 `cmd /c` 实测展开 `%变量%` 参数；直接进程版本保持百分号、引号、空格、中文、空参数、换行与反斜杠，保留数据根，并发回收大于管道缓冲区的 UTF-8 stdout/stderr，返回原状态 47。此项未请求 UAC，不等同于提权验收。
- 原生 worker 完成处理函数的隔离探针：9 个场景通过，覆盖完整 1223、成功、缺失/重复/损坏结果、VM 未完成、状态不一致与越界状态；不替代 Windows 实际取消提权验收。
- 发布保护：前端和 worker 均打包完成后注入无效原生清单，构建在第 3 步失败；已发布 macOS 文件 SHA-256 保持 `3946a61dda2d5c37541cf955729efaefca3f9bdd51ea5ba15389a2c2b1a47cf3` 不变。
- 根 `bun run check`、状态回归 2 项、SDK 定向回归 20 项 / 138 assertions 通过；开发宿主 Cargo 测试目标与 Rust 格式检查通过（宿主目前没有单元测试用例）。

**未覆盖的系统验收：**本轮未批准 UAC 提权、修改主机安全配置或注册真实计划任务，也未启动真实游戏服务端。UAC 取消的完整 1223 目前由完成协议探针覆盖，提权中转由非提权进程探针覆盖；不能据此声称真实 UAC 取消、任务调度或真实游戏端到端已经通过。Windows 验证平台是 ARM64 Windows 11 上的 x64 EXE，不是独立 x64 物理机压力测试。

## 历史阶段记录

以下保留升级过程的证据边界；旁置运行时、CLI 和旧构建命令不再是当前使用方式。

## 2026-09-17：Windows Support 更新适配（目录重整前）

- **接入方式不变**：本次未修改 TS 组件、router/Vite 插件 API、宿主 profile 入口或工具链版本。保留外部 Bun + `ProcessAdapter` / `StdioTransport`、自有 Cargo 宿主及 `native:` 绑定导出；重新构建宿主并生成绑定，Bun 与 Cargo 锁文件无需调整。
- **Windows 修复随子模块引入（源码分析）**：debug 渲染器将 HLSL 及 include 嵌入 EXE，从内存编译，不再读取构建机源码目录；Windows 资源 manifest 通过绝对路径宏传给资源编译器。已有 `gpui-pre` / `gpui-pre-windows` path patch 覆盖这两处，无需应用侧补丁。旧 EXE 必须重建，单换 JS 无法得到修复。[上游 Windows 排障说明](https://github.com/Cyenoch/solid-gpui/blob/e5448f62cbdde66c67d9d073609a0fab185697c3/docs/troubleshooting.zh-CN.md#windows-debug-启动时无法创建-directwritetextsystem)
- **Release 构建要求**：仍需 Windows SDK 的 `fxc.exe`，可用 `GPUI_FXC_PATH` 指定；debug 的内存着色器编译不等于 release 着色器构建已验收。
- **不迁移实验性内嵌 Bun**：上游新增静态打包器，但文档仍标为实验性，CI 未验证静态应用包。本面板继续使用旁置 Bun/JS 与独立日志守护，不在依赖适配中更换进程生命周期及分发契约。[上游分发边界](https://github.com/Cyenoch/solid-gpui/blob/e5448f62cbdde66c67d9d073609a0fab185697c3/docs/distribution.zh-CN.md#内嵌-bun-静态应用)

本轮验证：

- `bun install --frozen-lockfile`：通过，无依赖变更。
- `bun run check`：类型、规则与格式检查全部通过。
- `bun run gui:build`：通过；重编原生宿主、重新导出绑定并构建 164 个模块。Vite native-loader 告警仍存在，未隐藏。
- 原生宿主 locked 构建：通过；当时尚未目录重整，当前等价入口为 `bun run host:build`。`block v0.1.6` future-incompatibility 告警仍存在。
- SDK 定向回归：`native`、`control-flow`、`stdio-host-lifetime`、`application`、新增的 `scripts/solid-jsx.test.ts`，**20 passed / 0 failed，138 assertions**。使用 `--conditions=browser --preload ./vendor/solid-gpui/scripts/solid-jsx.ts`。
- macOS 原生窗口：使用新构建的 debug 宿主和 production bundle，在独立模拟目录中冷启动；已观察总览首帧、模拟实例启动、玩家三行六列表格、机器人对话框、Select 通过 Down + Enter 从队伍 0 更新为队伍 1，以及设置页滚动后的内容位移。没有帧时间测量，不把内容位移当作性能基准。
- Select 弹出选项仍为三个无名 AX `group`，旧 P1 未修复。Windows x64/MSVC、release 着色器、内嵌 Bun 与本轮开发期热重载未做运行验收；此前热重载结果仅作为历史记录。

## 旧十条痛点的处理

| 原问题                              | 当前结论                                                                        | 本仓库适配                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Windows 宿主栈溢出               | 上游 runner 管理应用线程与栈，默认 16 MiB；不是消除了任意深度递归。             | 删除自建 256 MiB 线程与 `AppHost` 转发包装，传入 profile 工厂，首帧配置使用 `ComponentHost::with_initialize`。[入口与栈策略][stack]              |
| 2. 嵌套 `undefined` 使渲染器退出    | 对象成员里的 `undefined` 现在递归省略；数组元素仍严格拒绝。                     | 删除 `definedChoice`，直接使用原生 Select。[JSON 边界][json]                                                                                     |
| 3. Select 当前值必须在 items 中     | 现在保留未解析的受控 key，目录到达后再解析；空 key/重复 key 仍非法。            | 删除 `controls.tsx`，迁移全部 6 个调用页面；保留数据源去重与空值哨兵，配置页不再撤掉未知 `value`。[选择状态][choices]                            |
| 4. `hotKey` 与空首帧                | 上游没有独立定位旧报告的根因；本次已验证推荐写法可在本面板启动和热重载。        | 启用 `hotKey: import.meta.hot ? import.meta.url : undefined`；实测同一窗口/宿主保留 `/server/players`，日志到达 epoch 3。[生命周期][application] |
| 5. `host` / `native` 组件目录不一致 | 显式 `host` 也导出自身契约，不再替换为 SDK 静态目录。                           | 保留适合自有 Cargo 宿主的 `native:` 配置，仅修正旧注释。换 pin 后重新生成绑定。[导出契约][catalog]                                               |
| 6. Windows `.SystemUIFont` 无法解析 | 上游从 Windows OS UI 字体解析别名。                                             | 删除 Microsoft YaHei UI 手动覆盖。Windows 字体观感仍待目标机验证。[字体解析][font]                                                               |
| 7. 长页面滚动/剩余空间布局          | 有界视口与自然高度内容仍是调用契约；布局正确不代表滚动足够快。                  | 保留 `PageScroll`，封禁页也改用该公共组件；用户本轮报告的卡顿单独列为未解决性能问题。[滚动规则][scroll]                                          |
| 8. Solid `For` / `Show` 类型不兼容  | `@solid-gpui/core/runtime` 已导出原生类型的控制流组件。                         | 删除禁用注释，不为改语法而重写现有页面。[原生控制流][runtime]                                                                                    |
| 9. 宿主强杀留下 Bun 孤儿            | 默认 `StdioTransport` 随 stdin EOF/错误结束渲染器，自定义流需显式选择退出策略。 | 删除 `watchHostProcess`；本机强杀测试通过，detached 模拟引擎仍存活。[stdio 生命周期][stdio]                                                      |
| 10. 图标白名单                      | 有意的离线契约，不是待修缺陷；可注册应用图标。                                  | 保持类型检查，不把任意字符串强转为 `IconName`。[图标契约][icons]                                                                                 |

`Action` 的样式和 `MotionMode::Reduced` 继续保留，属于产品选择，不再用“原生 Button 必崩”解释。

### 同时修正的应用侧用法

- **按钮名称与键盘**：公共 `Action` 增加名称、禁用语义、焦点和 Enter/Space 激活。禁用时必须同时移除 `onKeyDown`，否则违反 `Pressable onKeyDown requires focusable=true`。本次遇到该校验后已修正，随后成功启动模拟实例并打开机器人对话框。
- **表格伸缩列**：玩家页实测只有第一列可见。Kit 在单元格省略 width 时使用 100% flex basis；我们又指定 `flexShrink: 0`，挤出了其他列。玩家/封禁表的伸缩列改为 `width: 0 + flexGrow: 1`；玩家六列和封禁五列均已目视确认。[Kit 单元格默认布局][table]
- **封禁页纵向压缩**：改用现有 `PageScroll`，不再让卡片挤在视口高度里导致台账行被压扁。已确认台账行可见。
- **受控确认无需业务手写**：生成的 Select props 已 `Omit<..., "ackEditSeq">`，SDK 自动回填确认序号。不能因为页面没有传 ack 就认定它有问题。[自动确认][ack]

这些不是要求上游修复的应用 bug。

## 已修复：高内容页面滚动卡顿（用户已于 2026-09-16 确认）

**用户报告**：“服务器配置等内容区域很高的页面，性能很差，滚动的时候很卡顿。”补丁热更新后，用户在同一 macOS 窗口、同一窗口大小下复测，确认**不卡了**。用户确认是本条的验收信号。

**原因（源码级，未做 CPU 采样）**：设置页有 14 组控件；外壳主内容行、剩余宽度列、设置页右栏与字段编辑器包装都靠 `flexGrow` 占剩余空间，却没有明确初始主轴尺寸。Taffy 在 `flex-basis: auto` 且主轴尺寸不确定时，会先按 max-content 测量子树再分配剩余空间（`taffy 0.13.0/src/compute/flexbox.rs:743-803`），于是每帧都要对整棵长页面做 intrinsic 探测。上游对这类容器已有相同规则：给零初始尺寸。[已知性能案例][scroll]

**改动（有界，仅此三处）**：

- `src/components/shell.tsx`：主内容行加 `height: 0`，其内容列加 `width: 0`；
- `src/routes/config/server.tsx`：右栏、字段当前值、编辑器包装加 `width: 0`；
- 保留原有最小尺寸、全部 14 项控件、文字换行与内容自然高度；未引入分页、虚拟列表、固定内容高度或布局缓存。

**同时排除的假设**：`session.ts` 的 fast/slow 定时器只更新实例、玩家、日志与体检，不更新 settings/catalog；`PageScroll` 未订阅 `onScroll`，滚轮路径无需逐帧 JS 回传。所以不是“定时器反复重建全部设置编辑器”。运行中实例每 1.5 秒一次的窗口标题命令会触发一次整树重建，是独立的周期性小停顿，本次未处理。

**边界**：只有用户观感确认，没有前后 CPU 采样或 `frame-profile` 数字；未验证其他长页面，未在 Windows 目标平台验证。要定量或防回归，按上游流程采集对应时段的原生主线程调用栈/帧指标，并与空闲区间分开统计。[测量边界][perf]

## 仍需处理的痛点

### P1：原生 Select 弹出选项缺少可访问名称

**本机实测**，不是公共 `Action` 未传 label 那个应用问题：

1. `bun run gui:dev`，玩家列表 → 加机器人 → 展开“机器人队伍”。
2. Select 已显式传 `accessibilityLabel="机器人队伍"`；画面显示三个队伍选项。
3. AX 树能读到触发器名称和值，弹出内容却只有三个无名 `group`：

```text
popupbutton "机器人队伍": "队伍 0（默认）"
list
  group
  group
  group
```

最小组件形状（不用本项目包装层）：

```tsx
<Select
  accessibilityLabel="机器人队伍"
  value="0"
  items={[
    {
      key: "teams",
      items: [
        { key: "0", label: "队伍 0（默认）" },
        { key: "1", label: "队伍 1" },
        { key: "2", label: "队伍 2" },
      ],
    },
  ]}
/>
```

键盘向下 + Enter 可以将当前值改成“队伍 1”，因此不是选项未加载。问题在于读屏/按名称自动化无法辨认内部选项。

源码链：[SearchableListAdapter][list-adapter] 把 `item.render()` 当视觉子节点传入；[SearchableListItemElement][list-item] 绘制文字、勾选和禁用样式，但没有提供选项名称/角色。建议上游在内部选项行暴露名称、选中/禁用状态和操作语义，并加平台 AX 验证。仅给外部 Select 加 label 无法补齐内部选项。

### P2：Vite 原生配置加载兼容性告警

**本仓库 `bun run gui:build` 实际输出**：上游 router 的 Vite 插件使用无扩展名相对导入，不兼容 Vite 计划采用的默认 `configLoader: 'native'`：

- `packages/solid-gpui-router/src/vite.ts`：`./generation-session`、`./generator`；
- `packages/solid-gpui-router/src/generation-session.ts`：`./generator-engine`。

当前 Vite 8.2.2 构建成功，这不是当前构建阻断。建议上游补全配置执行链的扩展名，并给源码消费场景加 native config-loader 验证；不要靠 `VITE_CONFIG_NATIVE_IGNORE_WARNING=true` 隐藏问题。[插件入口][router-vite]

### P1（发布验证）：本面板 Windows x64/MSVC 尚未验收

上游记录使用 Windows 11 ARM64 VM、x86-64 GNU debug 宿主和 ARM64 Bun；不是本面板，也不是 MSVC 验证。[上游资格边界][verification]

本面板过去只知 Windows 的 1 MiB 会崩、256 MiB 可运行。上游示例的 16 MiB 通过，**不能推导出本面板已通过或最小栈就是 16 MiB**。发布前需在目标 Windows x64/MSVC 环境验证复杂页面、连续切页与中文字体；用 `SOLID_GPUI_LOG=info` 查看预留，必要时通过上游的 `SOLID_GPUI_APP_STACK_BYTES` 指定预算，不恢复应用自建线程。

对上游的诉求是补目标平台 CI/可重复运行证据；本面板自身的发布验收仍由我们负责。另有 `block v0.1.6` 的 Rust future-incompatibility 告警，目前不阻断构建。

## 2026-09-16 验证记录与边界（历史 pin `fbd73f6`）

- 原生宿主 locked 构建：通过（当前等价入口 `bun run host:build`）。
- `bun run check`：类型、规则、格式全部通过。
- `bun run gui:build`：通过，实际宿主重新导出了原生绑定。
- SDK 定向回归：`native`、`control-flow`、`stdio-host-lifetime`、`application`，共 **19 passed / 0 failed，136 assertions**。命令需带 `--conditions=browser --preload ./vendor/solid-gpui/scripts/solid-jsx.ts`；漏掉 browser 条件会解析到 Solid SSR，不是上游回归。
- macOS 原生窗口：启动模拟实例、Action 键盘激活、机器人队伍选择、玩家/台账表格列均已观察；不是 Windows 验证。
- 开发期：同一宿主 PID/窗口经历 managed reload，保留玩家路由，日志出现 epoch 3；后续修改也成功热重载。
- 未知目录值：持久地图临时设为 `dev_unlisted_map` 后冷启动，页面显示该配置值和“当前值不在清单里”，没有提交被拒/渲染器退出；测试后已恢复原地图。
- 强杀已确认身份的本面板宿主，50 ms 轮询在约 **54 ms** 时发现 Bun renderer 已退出，模拟引擎仍活着。这个数字是一次退出检测，不是延迟基准。
- **滚动流畅度：用户已确认修复**。补齐剩余空间容器的零初始尺寸后，用户在同一窗口复测“服务器配置”页并确认“不卡了”。这是观感验收，不是 CPU 或帧时间测量；先前合成滚轮没有可靠内容位移证据，仍不计入通过项。

[stack]: https://github.com/Cyenoch/solid-gpui/blob/fbd73f66d54d0725d1c901a7cfc358d1a367d676/crates/solid-gpui/src/host/launch.rs#L21-L65
[json]: https://github.com/Cyenoch/solid-gpui/blob/fbd73f66d54d0725d1c901a7cfc358d1a367d676/packages/solid-gpui/src/native.ts#L80-L103
[choices]: https://github.com/Cyenoch/solid-gpui/blob/fbd73f66d54d0725d1c901a7cfc358d1a367d676/crates/solid-gpui/src/components/choices.rs#L284-L323
[application]: https://github.com/Cyenoch/solid-gpui/blob/fbd73f66d54d0725d1c901a7cfc358d1a367d676/packages/solid-gpui/src/application.ts#L142-L200
[catalog]: https://github.com/Cyenoch/solid-gpui/blob/fbd73f66d54d0725d1c901a7cfc358d1a367d676/packages/solid-gpui-vite/src/native-export.ts
[font]: https://github.com/Cyenoch/solid-gpui/blob/fbd73f66d54d0725d1c901a7cfc358d1a367d676/vendor/gpui-windows/src/direct_write.rs#L1888-L1925
[scroll]: https://github.com/Cyenoch/solid-gpui/blob/fbd73f66d54d0725d1c901a7cfc358d1a367d676/docs/scroll-performance.md
[runtime]: https://github.com/Cyenoch/solid-gpui/blob/fbd73f66d54d0725d1c901a7cfc358d1a367d676/packages/solid-gpui/src/runtime.ts#L55-L124
[stdio]: https://github.com/Cyenoch/solid-gpui/blob/fbd73f66d54d0725d1c901a7cfc358d1a367d676/packages/solid-gpui/src/stdio.ts#L114-L284
[icons]: https://github.com/Cyenoch/solid-gpui/blob/fbd73f66d54d0725d1c901a7cfc358d1a367d676/docs/iconify.md
[table]: https://github.com/Cyenoch/solid-gpui/blob/fbd73f66d54d0725d1c901a7cfc358d1a367d676/vendor/gpui-kit/crates/component/src/table/table.rs#L494-L509
[ack]: https://github.com/Cyenoch/solid-gpui/blob/fbd73f66d54d0725d1c901a7cfc358d1a367d676/packages/solid-gpui/src/native.ts#L206-L214
[perf]: https://github.com/Cyenoch/solid-gpui/blob/fbd73f66d54d0725d1c901a7cfc358d1a367d676/docs/performance-analysis.md
[list-adapter]: https://github.com/Cyenoch/solid-gpui/blob/fbd73f66d54d0725d1c901a7cfc358d1a367d676/vendor/gpui-kit/crates/component/src/searchable_list/adapter.rs#L113-L155
[list-item]: https://github.com/Cyenoch/solid-gpui/blob/fbd73f66d54d0725d1c901a7cfc358d1a367d676/vendor/gpui-kit/crates/component/src/searchable_list/item.rs#L96-L138
[router-vite]: https://github.com/Cyenoch/solid-gpui/blob/fbd73f66d54d0725d1c901a7cfc358d1a367d676/packages/solid-gpui-router/src/vite.ts#L1-L6
[verification]: https://github.com/Cyenoch/solid-gpui/blob/fbd73f66d54d0725d1c901a7cfc358d1a367d676/.scratch/desktop-app/verification.md
