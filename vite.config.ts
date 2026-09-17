import { resolve } from "node:path";
import { defineConfig } from "vite";
// 这两个包必须按路径导入：它们是 vendor/solid-gpui 工作区的成员，没有 npm 包可解析，
// 而 Vite 配置本身在插件生效前就要被加载，用不了下面的 resolve.alias。
import { solidGpuiRouter } from "./vendor/solid-gpui/packages/solid-gpui-router/src/vite.ts";
import { solidGpui } from "./vendor/solid-gpui/packages/solid-gpui-vite/src/index.ts";

const root = import.meta.dirname;
const solid = resolve(root, "vendor/solid-gpui");
const core = (file: string) => resolve(solid, "packages/solid-gpui/src", file);

export default defineConfig({
  root,
  plugins: [
    solidGpuiRouter(),
    solidGpui({
      entry: "src/app.tsx",
      runtime: "bun",
      // 用 `native`：它按 Cargo 工程构建并监听我们这个宿主，再让宿主执行 `--export-native`，
      // 把 gpui-component 的组件目录（含 catalog digest）现场生成到 src/generated/native.ts，
      // 供 `@solid-gpui/core/components` 使用。宿主是应用自有的 Rust 工程（只注册内置组件模块），
      // 正是 `native` 的适用场景：不用声明应用自有的原生模块，也能自动重建（上游 docs/vite.md）。
      // 早先那条"用 `host` 会拿到 checked-in 目录、digest 对不上"的结论已作废：`host` 现在也会
      // 用自己那个可执行文件导出目录，导出失败就报错，不再替换成 SDK 里的绑定。
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
      { find: "@solid-gpui/core/embedded", replacement: core("embedded.ts") },
      { find: "@solid-gpui/core/runtime", replacement: core("runtime.ts") },
      { find: "@solid-gpui/core/native", replacement: core("native.ts") },
      { find: "@solid-gpui/core/motion", replacement: core("motion.ts") },
      { find: "@solid-gpui/core/jsx-runtime", replacement: core("jsx-runtime.ts") },
      { find: "@solid-gpui/core", replacement: core("index.ts") },
      // 面板与后台 worker 共用根 src/ 下的业务实现。
      { find: "@server", replacement: resolve(root, "src") },
    ],
  },
  build: { outDir: "native/target/bundles", target: "esnext" },
});
