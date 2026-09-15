# solid-gpui 踩坑记录（Windows / 本 pin）

面板用 [solid-gpui](https://github.com/Cyenoch/solid-gpui) 写（子模块 `vendor/solid-gpui`，pin `66f17e0`）。
下面每一条都是**本机实测**出来的：症状 → 证据 → 我们怎么绕开。上游修了就能删掉对应条目。

环境：Windows 11 26200 / `r5-server-gui.exe`（debug 宿主）+ Bun 1.4.2 子进程。

---

## 1. 宿主栈溢出（`thread 'main' has overflowed its stack`，退出码 29）

**症状**：面板起来后 2–9 秒随机崩，窗口一闪。退出码 29。

**证据**

- `Button` / `TabBar` 这类**带动画**的控件必崩；`motion::set(Reduced)` 后它们不再崩，但复杂布局（配置页 14 项设置）仍偶发崩。
- 60 秒常驻 + 反复切路由的 soak 里，把应用放到 256 MiB 栈的线程上跑就完全不复现；默认 1 MiB 主线程栈必崩。

**结论**：本 pin 的 vendored gpui 在 Windows 上会走出很深的递归（布局与过渡动画两条路径都观察到过），1 MiB 栈不够；栈深本身是有限且稳定的。

**做法**（`desktop/native/src/main.rs`）

- 应用整体放在自建的 256 MiB 栈线程上执行（GPUI 在 Windows 不要求主线程）。
- 关掉装饰性动画：`solid_gpui::motion::set(MotionMode::Reduced, cx)`（产品上也成立：运维面板不需要动效）。
- UI 里不使用 gpui-component 的 `Button` / `TabBar` / `Tab`，用 `Pressable + Icon + Text` 自建（`components/ui.tsx` 的 `Action`）。

---

## 2. 数据 props 里的嵌套 `undefined` 会打死渲染器

**症状**：点某个页面 → 窗口变白、Bun 子进程退出、宿主报 `renderer runtime terminated unexpectedly: exited with status 1`。

**证据**：`r5-server-gui.js` 抛
`TypeError: Native JSON contains an unsupported value at jsonValue ... at encodeJson`。
源码在 `packages/solid-gpui/src/native.ts`：顶层 props 的 `undefined` 会被丢掉（`omitUndefined: true`），
`style` 根本不走 JSON（`HOST_PROPS`），但**数组/对象里的 `undefined` 直接抛**。
最小复现：`Select` 的某个选择项带 `description: undefined`。

**做法**：`desktop/src/components/controls.tsx` 包一层 `Select`，进原生层之前剔掉可选字段的 `undefined`，并统一从那里导出。页面不要再直接从 `@solid-gpui/core/components` 拿 `Select`。

---

## 3. `Select` 的原生硬校验：选中的值必须在 items 里

**症状**：窗口画不出来（首帧被拒），宿主只回一行英文：
`surface 1 rejected commit: extension node N has invalid properties: selected choice keys must be unique and present in items`；
Bun 子进程随后 `exit 1`。

**证据**：`crates/solid-gpui/src/components/choices.rs` 的 `validate()` —— 分组 key 与条目 key 必须非空且唯一，
且 `value`（或 `defaultValue`）必须命中某个条目 key，否则整个提交被拒。
实测踩点：控制面板的模式下拉，`value` 来自配置里的模式 id，而清单要异步读服务器目录 —— 两者对不上是常态，不是异常。

**做法**：同一个包装层里

- 丢掉空 key、跨分组去重；
- 当前值不在清单里时**补一条同名条目**（`description: "当前值"`）—— 界面显示"现在的值"，宿主也永远校验通过。
  早先试过"值不合法就不传"，在受控组件路径上不可靠（JS 侧还会重发一次），别回退到这个写法。

---

## 4. 开发模式：`hotKey` 让首次提交变成空 diff

**症状**：`bun --bun vite` 起不来，`Error: application must render a nonempty initial tree`（`application.ts` 的 `assertReady`）。
生产构建（`vite build` + `--production`）没有这个问题。

**证据**：同一份代码去掉 `hotKey` 就能正常挂载；带上时 `mountApplication` 把这次求值当成对**已提交树**的重挂载，
首帧被算成空 diff，`CandidateTransport.frames` 为空 → 宿主拒绝提交。

**做法**：`desktop/src/app.tsx` 不传 `hotKey`。插件的开发循环本来就是"保存即重开会话"，没有实际损失。

---

## 5. 组件目录 digest 对不上：必须用 `native` 而不是 `host`

**症状**：宿主接受连接但拒绝所有渲染提交（`native contract mismatch`）。

**原因**：`host` 选项用的是仓库里 checked-in 的 `components.ts`，它的 catalog digest 与本机宿主编译出来的不同。

**做法**：`desktop/vite.config.ts` 用 `native: { manifestPath, bin, output }`，让 Vite 用**我们自己的宿主**执行
`--export-native`，现场生成 `desktop/src/generated/native.ts`（构建产物，不入库）。

---

## 6. 默认字族 `.SystemUIFont` 在 Windows 上不存在

**症状**：中文与部分文本走字体回落路径，渲染异常。

**做法**：宿主 `initialize` 里 `gpui_component::Theme::global_mut(cx).font_family = "Microsoft YaHei UI"`。
（字体**不是**栈溢出的原因，见第 1 条。）

---

## 7. 布局：GPUI 不是 CSS

- **每一层都要显式 `flexDirection`**。默认 `row`：子节点的 `flexGrow` 会去撑宽而不是撑高。
  本机踩点：外壳内容区少写一个 `flexDirection: "column"`，页面里的 `height: 0 + flexGrow: 1` 滚动区塌成 0 高度 → 整页空白。
- **占满剩余高度** = `height: 0 + flexGrow: 1 + minHeight: 0`（`height: 0` 是初始主轴尺寸，不是最终高度）。
- **`overflow: "scroll"` 放在同时带 `flexGrow: 1` 的根节点上不会滚**：根被撑到视口高度，内容超出只是被裁掉，
  滚动条不出现、滚轮也不动，底部内容永远够不到。
  **做法**：`components/ui.tsx` 的 `PageScroll` —— 外层 `Scrollable` 负责滚动，内层 `flexShrink: 0` 保持自然高度。
- 裸文本必须包在 `<Text>` 里；未知 prop 直接抛 `Unknown native prop: x`。

---

## 8. Solid 的 `For` / `Show` 类型与原生 JSX 运行时不兼容

**做法**：条件用 `? :`，列表用 `.map()`。这条写进了 `components/ui.tsx` 开头的硬约束。

---

## 9. 宿主被强杀时 Bun 子进程会变孤儿

**症状**：任务管理器结束 `r5-server-gui.exe`（或宿主崩溃）后，`bun r5-server-gui.js` 一直挂着，
累积几十个进程，每个都占着内存与协议管道。

**做法**：子进程自己盯父进程（`desktop/src/app.tsx` 的 `watchHostProcess`）：每 2 秒
`process.kill(ppid, 0)`，父进程没了就 `exit(0)`。
引擎（`r5apex_ds.exe`）与日志守护是 `Bun.spawn({ detached: true })` 起的，不受影响 —— **关掉面板不会带走正在跑的服务器**。

---

## 10. 图标名是白名单

`Icon` 的 `name` 只能取 `packages/solid-gpui/src/protocol/types.ts` 里 `ICON_NAMES` 列出的值，
写错就是一条 `TS2322`（例如 `lucide:wrench`、`lucide:rotate-cw` 都不在表里；用 `lucide:refresh-cw`）。

---

## 调试这些问题的常用手法（本机有效）

- 崩溃先看子进程 stderr：宿主会把 `renderer runtime terminated unexpectedly` 与 JS 的异常栈打出来。
- 「窗口变白」几乎都是**提交被拒**：宿主 stderr 会写 `rejected renderer commit: ...` 与具体原因，照那句话去 Rust 源码里搜。
- 验证不用真鼠标：`PrintWindow(hwnd, dc, 2)` 能抓到被遮挡的窗口（不抢前台、不动光标）。
- 起始页面可以通过 `r5-server.json` 的 `panelRoute` 指定，重启即进对应页面 —— 逐页截图验证不需要任何输入。
