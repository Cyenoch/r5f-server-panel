/**
 * 唯一的 Vite 配置：应用入口与内部 worker 入口都从这里出。
 *
 * 两种模式，同一个文件（`--mode worker` 选 worker）：
 *
 * - 默认（`bun --bun vite` / `bun --bun vite build`）：面板应用入口。`solidGpui()` 负责
 *   JSX 变换、`solid-js` 去重、`#native` / `@solid-gpui/core/components` 到宿主绑定文件的
 *   解析，构建时还会按 `native` 编译并导出宿主契约、写出 `.solid-gpui/artifacts.json`。
 * - `worker`（`bun --bun vite build --mode worker`）：`src/worker-entry.ts` 打成单文件
 *   `worker.js`，与 `app.js` 同目录。两个入口必须同目录：序列化器按"相对所有入口的公共
 *   根目录"给额外入口命名，同目录时 worker 的图键就是文件名本身。
 *
 * worker 分支**不挂** `solidGpui()`：它会去编译宿主、把 `build.ssr` 改成应用入口，并在构建
 * 结束时写 `.solid-gpui/artifacts.json` —— 那些都属于应用构建，worker 构建只会覆盖掉它的
 * 结论。因此这里显式把 worker 需要的那几项抄齐（Node/Bun 内置保留为运行时 import、
 * `appType: "custom"` 无 HTML 入口、与 `NODE_ENV=production` 一致的解析条件）。
 *
 * 顺序：应用构建会清空 `build.outDir`，所以 worker 构建必须排在应用构建**之后**。
 *
 * 应用自有的 specifier 是 `#server/*`：解析来自 package.json 的 `imports`（标准包内自引用），
 * 两个模式都不用别名，也不用 tsconfig paths —— 见下面关于 `#server/*` 的说明。
 */
import { existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { solidGpuiRouter } from "@solid-gpui/router/vite";
import { solidGpui } from "@solid-gpui/vite";
import { defineConfig, type UserConfig } from "vite";

const root = import.meta.dirname;
/** 构建中间物目录。应用入口 `app.js` 与 worker 入口 `worker.js` 都落在这里。 */
const outDir = "native/target/bundles";
/** 内部 worker 的进程入口（宿主 `--worker` 模式重进的同一份代码）。 */
const workerEntry = resolve(root, "src/worker-entry.ts");
/** `solid-gpui prepare` 生成的 TypeScript 工程，根 tsconfig.json extend 它。 */
const tsconfigFile = resolve(root, ".solid-gpui/tsconfig.json");

/**
 * 面板与 worker 共用根 `src/` 下的业务实现，specifier 是 `#server/*`。
 *
 * 解析不在这里：那是 package.json 的 `imports`（`"#server/*": "./src/*.ts"`）—— 标准包内
 * 自引用，TypeScript（moduleResolution bundler）、Vite（resolveSubpathImports）、Bun 三边
 * 同一个来源，所以既不需要 `resolve.alias`，也不需要往 tsconfig 抄一份 `paths`
 * （TypeScript 不合并 `compilerOptions.paths`，抄一份就会顶掉生成 tsconfig 里
 * `#native` / `@solid-gpui/core/components` 那两条）。
 *
 * SDK 自己的包名（`@solid-gpui/core` 及其子路径、`@solid-gpui/router`、`@solid-gpui/vite`）
 * 一律走包 exports，这里不许出现覆盖它们的 alias：手动抄一份子路径表就会和包里的 export map
 * 悄悄分叉；`#native` 与 `@solid-gpui/core/components` 由 `solidGpui()` 指向本次宿主导出的
 * 绑定文件，也不该由应用接手。
 */

/** 应用与 worker 共用的 Vite 设置。 */
const shared: UserConfig = {
  root,
  // 没有 HTML 入口：应用入口由 `solidGpui({ entry })` 指定，worker 入口由 build.ssr 指定。
  appType: "custom",
};

export default defineConfig(({ mode }) => {
  if (mode === "worker") {
    // 根 tsconfig.json extends 生成的那份，rolldown 读 tsconfig 时找不到它就直接报
    // “Tsconfig not found”。worker 构建本身不生成它（生成属于应用构建），所以在这里
    // 先把话说清楚：先跑应用构建（`bun run build`）或 `bun run generate`。
    if (!existsSync(tsconfigFile)) {
      throw new Error(
        `worker 构建需要生成好的 TypeScript 工程：${tsconfigFile} 不存在。` +
          `先跑 \`bun run generate\`（或 \`bun run build\`，它包含生成步骤）。`,
      );
    }
    return {
      ...shared,
      build: {
        outDir,
        target: "esnext",
        // 应用构建刚写过同一个目录：worker 只补自己的那一个文件，不清理别人的产物。
        emptyOutDir: false,
        ssr: workerEntry,
        rolldownOptions: { output: { entryFileNames: "worker.js" } },
      },
      ssr: {
        // worker 是自足的单文件：第三方依赖打进来，Node/Bun 内置留给运行时 import。
        noExternal: true,
        external: [],
        resolve: {
          externalConditions: ["bun", "browser"],
          conditions: ["bun", "browser", "module", "development|production"],
        },
      },
      environments: {
        ssr: {
          resolve: { builtins: [...builtinModules, /^node:/, "bun", /^bun:/] },
        },
      },
    } satisfies UserConfig;
  }
  return {
    ...shared,
    plugins: [
      // 路由树生成必须排在 JSX 编译之前：它先写出 `src/routeTree.gen.ts`，
      // 应用里的 `./routeTree.gen` 才有东西可解析。旧的 `scripts/generate-routes.ts`
      // 只是这件事的手工副本，插件已包含它（含增删改的增量重生成）。
      solidGpuiRouter(),
      solidGpui({
        entry: "src/app.tsx",
        // 外部 Bun：`mountApplication` 用 `StdioTransport`，构建保留 Bun/Node 内置 import。
        runtime: "bun",
        // 应用自有的 Rust 宿主。`native` 会按 Cargo 工程编译并监听原生改动，
        // 再让宿主执行 `--export-native` 导出组件目录（含 catalog digest）。
        // 开发/生成用的就是本机这个可执行文件，所以这里**不设** `target`：
        // 交叉目标既不能被 prepare 执行，也不是开发要跑的东西。
        native: {
          manifestPath: "native/Cargo.toml",
          // native/Cargo.toml 只有这一个 bin，写出来是为了让选择明确。
          bin: "r5-server-gui",
          output: "src/generated/native.ts",
        },
      }),
    ],
    build: {
      outDir,
      target: "esnext",
      // 固定入口名：打包脚本要按文件名给模块图入口命名，`app.js` 是它与本仓库的约定。
      rolldownOptions: { output: { entryFileNames: "app.js" } },
    },
  } satisfies UserConfig;
});
