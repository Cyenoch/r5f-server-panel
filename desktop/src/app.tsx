import { mountApplication, type Root } from "@solid-gpui/core";
import { StdioTransport } from "@solid-gpui/core/stdio";
import { RouterProvider } from "@solid-gpui/router";
import { bindRoot } from "./lib/host";
import { rememberRoute, rememberedRoute } from "./lib/route-memory";
import { createAppRouter } from "./router";

/**
 * 宿主（`r5-server-gui.exe`）被强杀或崩溃时，本进程的存活由 `StdioTransport` 接管：
 * 它默认以 `process.stdin` / `process.stdout` 为协议管道，管道关闭（EOF）即 `exit(0)`、
 * 读写出错则 `exit(1)` —— 所以不需要再自己轮询父进程 pid。
 *
 * 只影响本进程：引擎（`r5apex_ds.exe`）与日志守护都是 `Bun.spawn({detached: true, stdin: "ignore"})`
 * 起的，不在这里的管辖范围内 —— 关掉面板不会带走正在跑的服务器。
 */
mountApplication<string>({
  transport: () => new StdioTransport(),
  // 开发期把每次求值登记成同一个 hotKey 的「上一代应用」，保存源码就在原窗口里换掉应用树。
  // 历史记录：早先带 `hotKey` 会以 “application must render a nonempty initial tree” 拒提交，
  // 上游已修托管重载的状态交接与重开 surface 的首帧，但那条原始报告上游未单独复现 ——
  // 结论与不确定度见 `docs/solid-gpui-notes.md` 第 4 条。
  hotKey: import.meta.hot ? import.meta.url : undefined,
  setup(previousPath) {
    // 宿主在渲染器重载时会递上来一个路径；进程重启时没有，就回到上次停的那一页。
    const router = createAppRouter(previousPath ?? rememberedRoute());
    router.subscribe("onResolved", () => rememberRoute(router.state.location.href));
    return {
      render: () => <RouterProvider router={router} />,
      onMount(root: Root) {
        bindRoot(root);
      },
      captureState: () => router.state.location.href,
    };
  },
});
