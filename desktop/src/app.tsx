import { mountApplication, type Root } from "@solid-gpui/core";
import { StdioTransport } from "@solid-gpui/core/stdio";
import { RouterProvider } from "@solid-gpui/router";
import { bindRoot } from "./lib/host";
import { rememberRoute, rememberedRoute } from "./lib/route-memory";
import { createAppRouter } from "./router";

/**
 * 宿主（`r5-server-gui.exe`）被强杀时本进程会变成孤儿：协议管道断了、没人回收它，
 * 只能自己盯着父进程，父没了就退出。
 *
 * 只影响本进程：引擎（`r5apex_ds.exe`）与日志守护都是 `Bun.spawn({detached: true})`
 * 起的，不在这里的管辖范围内 —— 关掉面板不会带走正在跑的服务器。
 */
function watchHostProcess(): void {
  const host = process.ppid;
  if (host <= 0) return;
  const timer = setInterval(() => {
    try {
      process.kill(host, 0);
    } catch {
      process.exit(0);
    }
  }, 2000);
  timer.unref?.();
}

watchHostProcess();

// 不传 `hotKey`：带上它时 `mountApplication` 会把本次求值当成对**已提交树**的重挂载，
// 于是首帧被算成空 diff，宿主以 “application must render a nonempty initial tree” 拒绝提交
// （本机实测：同一份代码去掉 hotKey 就能起来）。插件的开发循环本来就是保存即重开会话，
// 所以这里没有实际损失。
mountApplication<string>({
  transport: () => new StdioTransport(),
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
