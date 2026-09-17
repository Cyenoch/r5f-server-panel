// 独立生成路由树：CI 与类型检查在 Vite 之外也需要 `src/routeTree.gen.ts` 是新的。
import { resolve } from "node:path";
import { generateRoutes } from "../vendor/solid-gpui/packages/solid-gpui-router/src/generator.ts";

await generateRoutes({ root: resolve(import.meta.dirname, "..") });
