import { mountApplication, type Root } from "@solid-gpui/core";
import { EmbeddedTransport } from "@solid-gpui/core/embedded";
import { StdioTransport } from "@solid-gpui/core/stdio";
import { RouterProvider } from "@solid-gpui/router";
import { bindRoot } from "./lib/host";
import { rememberRoute, rememberedRoute } from "./lib/route-memory";
import { createAppRouter } from "./router";

// Development uses host-owned stdio; the packaged app shares the native process through EmbeddedTransport.
// Detached engine/log workers remain independent, so closing the panel never stops a server.
mountApplication<string>({
  transport: () => (process.env.R5_SERVER_PACKAGED === "1" ? new EmbeddedTransport() : new StdioTransport()),
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
