import { resolve } from "node:path";
import { defineConfig } from "vite";
// 这两个包必须按路径导入：它们是 vendor/solid-gpui 工作区的成员，没有 npm 包可解析，
// 而 Vite 配置本身在插件生效前就要被加载，用不了下面的 resolve.alias。
import { solidGpuiRouter } from "../vendor/solid-gpui/packages/solid-gpui-router/src/vite.ts";
import { solidGpui } from "../vendor/solid-gpui/packages/solid-gpui-vite/src/index.ts";

const root = import.meta.dirname;
const solid = resolve(root, "../vendor/solid-gpui");
const core = (file: string) => resolve(solid, "packages/solid-gpui/src", file);

export default defineConfig({
  root,
  plugins: [
    solidGpuiRouter(),
    solidGpui({
      entry: "src/app.tsx",
      runtime: "bun",
      // 不写 native 模块，但**必须**走 `native`：它让 Vite 用我们这个宿主执行
      // `--export-native`，把 gpui-component 的组件目录（含 catalog digest）现场生成到
      // src/generated/native.ts，并让 `@solid-gpui/core/components` 指过去。
      // 用 `host` 的话组件目录取的是仓库里 checked-in 的 components.ts —— 它的
      // digest 与本机宿主编译出来的对不上，宿主会拒绝所有渲染提交（实测）。
      native: {
        manifestPath: "native/Cargo.toml",
        bin: "r5-server-gui",
        output: "src/generated/native.ts",
      },
    }),
  ],
  resolve: {
    alias: [
      { find: "@solid-gpui/router", replacement: resolve(solid, "packages/solid-gpui-router/src/index.ts") },
      // 子路径必须排在裸包名前面，否则 `@solid-gpui/core/stdio` 会被当成目录。
      { find: "@solid-gpui/core/stdio", replacement: core("stdio.ts") },
      { find: "@solid-gpui/core/runtime", replacement: core("runtime.ts") },
      { find: "@solid-gpui/core/native", replacement: core("native.ts") },
      { find: "@solid-gpui/core/motion", replacement: core("motion.ts") },
      { find: "@solid-gpui/core/jsx-runtime", replacement: core("jsx-runtime.ts") },
      { find: "@solid-gpui/core", replacement: core("index.ts") },
      // 面板 API 与引擎逻辑都在仓库根的 src/ 下（CLI 与桌面端共用同一批实现）。
      { find: "@server", replacement: resolve(root, "../src") },
    ],
  },
  // 应用要直接复用仓库根的 src/*.ts（状态、引擎控制、目录解析），它们在工作区之外。
  server: { fs: { allow: [root, resolve(root, "..")] } },
  build: { outDir: "dist", target: "esnext" },
});
