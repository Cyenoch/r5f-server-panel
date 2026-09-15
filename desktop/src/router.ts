import { createRouter, type NativeRouterInstance } from "@solid-gpui/router";
import { routeTree } from "./routeTree.gen";

/** 本应用的 router 类型：注册给 `Register`，让 `Link`/`useNavigate` 有路由字面量补全。 */
export type AppRouter = NativeRouterInstance<typeof routeTree>;

/**
 * 一个表面一个 router：原生路由用的是内存历史，浏览器 hash 那套在这里不适用。
 * `initialPath` 由 `mountApplication` 的 `captureState` 交接，热重载后停在原页面。
 */
export function createAppRouter(initialPath = "/"): AppRouter {
  return createRouter({ routeTree, initialEntries: [initialPath] });
}

declare module "@solid-gpui/router" {
  interface Register {
    router: AppRouter;
  }
}
