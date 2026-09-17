#!/usr/bin/env bun
/**
 * 一条命令打出真正的单文件发行版：`dist/r5-server.exe`。
 *
 * 一个可执行文件里同时装着 GPUI 宿主、Bun/JSC 运行时、序列化后的前端 JS 与 worker
 * 入口，运行期不需要相邻的 Bun、`node_modules` 或任何 JS 目录树。
 *
 * 本脚本只做应用自己那一半：产出两个入口（应用入口走 `bun --bun vite build`，worker 入口走
 * 公开的 Vite `build()` API，同一份 vite.config.ts）、取固定版本的序列化器与（跨平台时的）
 * 编译基线、把「应用 Cargo 工程 + worker 入口」交给公共打包器 `@solid-gpui/vite/embedded`。
 * 原生图、序列化「应用入口 + worker」、生成应用 crate、链接与镜像复核都在打包器里完成：应用
 * 不再导入上游私有脚本，也不再复制清单校验、图解析或 crate 生成；`dist/` 只在打包器最后一步
 * 被原子替换（同目录临时文件 + 改名），失败不会覆盖上一次成功发布的文件。
 *
 * 环境变量（工具链与固定版本从 vendor/solid-gpui 现场读取，其余都有默认值）：
 * `R5_BUILD_BUN` 由固定提交构建的 Bun 序列化器、`R5_BUILD_BASE` 目标平台同提交的 Bun
 * 编译基线、`R5_BUILD_SOURCE` 本地 Bun checkout 种子、`R5_BUILD_CACHE` 缓存根、
 * `R5_BUILD_NINJA` ninja、`WINDOWS_SYSROOT`、`R5_BUILD_MACOS_SDK`、
 * `R5_BUILD_DEPLOYMENT_TARGET`。
 *
 * 序列化器与编译基线是**构建期工具**，上游不会替你构建或下载（见
 * vendor/solid-gpui/docs/distribution.md「Embedded Bun static applications」）：序列化
 * 载荷不带格式版本，所以打包器只接受提交与固定版本一致的 Bun，不匹配直接拒绝。
 *
 * 失败路径分两类：应用侧 preflight（参数、环境输入、工具链、显式覆盖的路径）在动任何重活之前
 * 停住，只报契约不满足、不打印调用栈；Vite 产出之后与打包器阶段的失败（入口 chunk 检索、SDK 的
 * 序列化器提交/原生清单/镜像与模块图校验）发生在重活之后，错误来自本脚本或 SDK，可能带调用栈，
 * 但失败不会覆盖已发布产物（发布是原子的）。
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readNativeArtifacts } from "@solid-gpui/vite/artifacts";
import {
  graphTargetSpec,
  packageEmbeddedApplication,
  readPinnedBunBuild,
  resolveEmbeddedTarget,
  type EmbeddedGraphTarget,
  type EmbeddedPackagingReport,
  type PinnedBunBuild,
} from "@solid-gpui/vite/embedded";
import { build as viteBuild, type Plugin } from "vite";
import { BuildFailure, fail, parseJsonObject, pathExists, run, sha256Hex, stringMapField } from "./build-support.ts";

const root = resolve(import.meta.dirname, "..");
/** 固定提交的上游 checkout：固定版本信息、补丁与应用 crate 都从它取。 */
const sdkRoot = join(root, "vendor", "solid-gpui");
/**
 * 应用自有的内嵌宿主。打包器会把这份 manifest 与 SDK 的补丁、profile 合并成最终链接用的
 * 一张 crate 图，再把 `packaged-main.rs` `include!` 进生成的 bin crate —— 那里能看见
 * 打包器写出的 `BUN_EMBEDDED_ENTRY` / `BUN_EMBEDDED_WORKERS`。
 */
const application = {
  manifest: join(root, "native", "Cargo.toml"),
  package: "r5-server-gui",
  features: ["embedded"],
  main: join(root, "native", "src", "packaged-main.rs"),
} as const;
const defaultTarget = "x86_64-pc-windows-msvc";
const phaseCount = 2;

interface Build {
  readonly pin: PinnedBunBuild;
  readonly triple: string;
  readonly profile: "debug" | "release";
  readonly graphTarget: EmbeddedGraphTarget;
  readonly output: string;
  readonly cache: string;
  readonly ninja: string;
  readonly serializer: string;
  readonly baseExecutable?: string;
  readonly sourceSeed?: string;
  readonly winsysroot?: string;
  readonly macosSdk?: string;
  readonly deploymentTarget?: string;
}

/** 交给打包器的两个已构建入口（Vite 产物，不是 TS 源码）。 */
interface Bundles {
  readonly entry: string;
  readonly worker: string;
}

function override(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

/** 显式覆盖必须是绝对路径：打包器按原样使用它，相对路径会随工作目录漂移。 */
function absoluteOverride(name: string): string | undefined {
  const value = override(name);
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) fail(`${name} 必须是绝对路径：${value}`);
  return value;
}

function phase(step: number, title: string): number {
  console.log(`\n[${step}/${phaseCount}] ${title}`);
  return Bun.nanoseconds();
}

function elapsed(started: number): string {
  return `${((Bun.nanoseconds() - started) / 1e9).toFixed(1)}s`;
}

/** 打包器每跑一条外部命令前回调一次：与 build-support 的 run 保持同一种日志形状。 */
function logCommand(command: readonly string[]): void {
  console.error(`  $ ${command.map((argument) => JSON.stringify(argument)).join(" ")}`);
}

async function createBuild(): Promise<Build> {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      profile: { type: "string", default: "release" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    printUsage();
    process.exit(0);
  }
  const profile = values.profile === "debug" || values.profile === "release" ? values.profile : undefined;
  if (profile === undefined) fail(`--profile 只能是 debug 或 release（收到 ${values.profile}）`);
  const triple = values.target ?? defaultTarget;
  // 公共目标矩阵：未知 triple 与只有 --prepare-only 的平台在这里就被拒掉，不产出半成品。
  const target = resolveEmbeddedTarget(triple);
  const graphTarget = target.graph;
  if (graphTarget === undefined) {
    fail(`目标 ${triple} 没有内嵌应用传输（${target.evidence}）：上游只支持 --prepare-only 的原生准备。`);
  }

  const pin = await readPinnedBunBuild(sdkRoot);
  const ninja = override("R5_BUILD_NINJA") ?? Bun.which("ninja");
  if (ninja === null || ninja === undefined) {
    fail(`找不到 ninja（固定版本要求 ${pin.ninjaVersion}）：装一个，或用 R5_BUILD_NINJA 指到可执行文件`);
  }
  // Windows 上默认走用户目录里的短路径：cmd/Ninja 对 checkout 深路径有限制。
  const defaultCache =
    process.platform === "win32"
      ? join(homedir(), ".cache", "r5b", sha256Hex(root).slice(0, 12))
      : join(root, "native", "target", "bun-static");
  const cache = resolve(override("R5_BUILD_CACHE") ?? defaultCache);

  const serializer = absoluteOverride("R5_BUILD_BUN");
  if (serializer === undefined) {
    fail(
      `缺少固定版本的 Bun 序列化器：打包器只接受由固定提交 ${pin.revision} 构建的 Bun，而它不会替你构建或下载。\n` +
        "  用 R5_BUILD_BUN 指向已有的那个可执行文件（绝对路径）；提交不匹配会被打包器拒绝。\n" +
        "  构建方式与全部前置条件见 vendor/solid-gpui/docs/distribution.md「Embedded Bun static applications」。",
    );
  }
  const baseOverride = absoluteOverride("R5_BUILD_BASE");
  // 图目标的宿主平台与构建机不一致时，序列化器产不出该平台的镜像：必须有同提交的编译基线。
  const needsBase = graphTargetSpec(graphTarget).host !== `${process.platform}-${process.arch}`;
  if (needsBase && baseOverride === undefined) {
    fail(
      `目标 ${triple} 的内嵌图目标 ${graphTarget} 不在本机（${process.platform}-${process.arch}）上：` +
        "必须给出目标平台、同一固定提交的 Bun 当编译基线，否则序列化器会去下载一份不受提交约束的 Bun。\n" +
        "  用 R5_BUILD_BASE 指向它（绝对路径）；交叉编译 Windows 还要设 WINDOWS_SYSROOT。",
    );
  }

  const macosSdk = override("R5_BUILD_MACOS_SDK");
  const deploymentTarget = override("R5_BUILD_DEPLOYMENT_TARGET");
  const sourceSeed = override("R5_BUILD_SOURCE");
  const winsysroot = override("WINDOWS_SYSROOT");
  return {
    pin,
    triple,
    profile,
    graphTarget,
    output: join(root, "dist", `r5-server${graphTargetSpec(graphTarget).executableSuffix}`),
    cache,
    ninja,
    serializer,
    ...(baseOverride === undefined ? {} : { baseExecutable: baseOverride }),
    ...(sourceSeed === undefined ? {} : { sourceSeed: resolve(sourceSeed) }),
    ...(winsysroot === undefined ? {} : { winsysroot: resolve(winsysroot) }),
    ...(macosSdk === undefined ? {} : { macosSdk: resolve(macosSdk) }),
    ...(deploymentTarget === undefined ? {} : { deploymentTarget }),
  };
}

/**
 * 前置检查：全部在做任何重活之前跑完，每一处失败都给出可执行的下一步。
 *
 * 这里只查「能不能开始」：应用半边的输入在不在、固定工具链在不在、被显式覆盖的文件在不在。
 * 真正的契约校验（目标矩阵、原生清单、镜像、模块图）由打包器自己完成。
 */
async function preflight(build: Build): Promise<void> {
  const inputs = [
    application.manifest,
    application.main,
    join(sdkRoot, "Cargo.toml"),
    join(sdkRoot, "crates", "solid-gpui-bun-sys", "bun_embed.patch"),
  ];
  for (const path of inputs) {
    if (!(await pathExists(path))) fail(`缺少构建输入：${path}`);
  }
  for (const [name, value] of [
    ["R5_BUILD_BUN", build.serializer],
    ["R5_BUILD_BASE", build.baseExecutable],
    ["WINDOWS_SYSROOT", build.winsysroot],
    ["R5_BUILD_MACOS_SDK", build.macosSdk],
  ] as const) {
    if (value !== undefined && !(await pathExists(value))) fail(`${name} 指向的文件不存在：${value}`);
  }
  if (build.sourceSeed !== undefined && !(await pathExists(join(build.sourceSeed, "scripts", "build.ts")))) {
    fail(`R5_BUILD_SOURCE 不是 Bun 源码 checkout（缺少 scripts/build.ts）：${build.sourceSeed}`);
  }

  const rustup = Bun.which("rustup");
  if (rustup === null) fail("PATH 里没有 rustup：原生图与应用 crate 都要用固定工具链构建");
  const options = { cwd: root, stdout: "capture", pinnedToolchain: true } as const;
  const toolchains = await run([rustup, "toolchain", "list"], options);
  const names = toolchains.split("\n").map((line) => line.trim().split(/\s+/)[0] ?? "");
  if (!names.some((name) => name === build.pin.toolchain || name.startsWith(`${build.pin.toolchain}-`))) {
    fail(`固定工具链未安装：rustup toolchain install ${build.pin.toolchain}`);
  }
  const targetList = await run([rustup, "target", "list", "--installed", "--toolchain", build.pin.toolchain], options);
  const installed = new Set(targetList.split("\n").map((line) => line.trim()));
  if (!installed.has(build.triple)) {
    fail(
      `固定工具链缺少 ${build.triple} 的标准库：rustup target add ${build.triple} --toolchain ${build.pin.toolchain}`,
    );
  }
  if (build.profile === "release") {
    // 发布档按原生清单的 cargoArgs 用 -Zbuild-std 重编 std：没有 rust-src 组件必然失败。
    const sysroot = await run([rustup, "run", build.pin.toolchain, "rustc", "--print", "sysroot"], options);
    if (!(await pathExists(join(sysroot, "lib", "rustlib", "src", "rust", "library")))) {
      fail(`发布档需要 rust-src 组件：rustup component add rust-src --toolchain ${build.pin.toolchain}`);
    }
  }
}

/**
 * 两个入口都由根目录那一份 vite.config.ts 产出：先 app，再 worker（顺序不能反：应用构建
 * 会清空输出目录）。
 *
 * 应用入口取 `.solid-gpui/artifacts.json` 里记录的 `bundle`：那是 solidGpui() 插件在
 * `writeBundle` 里按**实际产出**写下的路径，脚本不推导、也不拼。worker 没有产物记录，所以
 * 用公开的 Vite `build()` API 跑 worker 模式，从真实产出里取入口 chunk（见 buildWorkerBundle）。
 * 两个文件最后都要存在：某次构建失败会在这里停住，不会把上一次的残留喂给打包器。
 */
async function bundleApplication(): Promise<Bundles> {
  const started = phase(1, "打包前端与 worker（同一份 vite.config.ts）");
  // 应用构建走 CLI（`bun --bun vite build`）：它清空输出目录，并让 solidGpui() 写出产物记录。
  // `bun --bun vite` 自己再进一次 bun：把 PATH 顶到本进程的解释器，避免用到另一个 Bun。
  const bunDirectory = dirname(process.execPath);
  const inheritedPath = process.env.PATH;
  const env = { PATH: inheritedPath === undefined ? bunDirectory : `${bunDirectory}${delimiter}${inheritedPath}` };
  await run([process.execPath, "--bun", "vite", "build"], { cwd: root, env });

  const record = await readNativeArtifacts(root);
  if (record === undefined || record.bundle === undefined) {
    fail(
      "vite build 没有记录应用入口：.solid-gpui/artifacts.json 缺少 bundle（生产构建由 solidGpui() 插件写入实际产物路径）。\n" +
        "  确认应用构建跑的是 vite.config.ts 的应用分支，或单独跑一次 `bun run generate` 再重试。",
    );
  }
  const entry = resolve(record.bundle);
  // Vite 报告的路径（chunk 的 fileName / facadeModuleId）统一用 `/`：应用记录下来的 outDir
  // 是本机分隔符，先统一再比较，不然后面每处都得各写一遍替换。
  const worker = await buildWorkerBundle(resolve(record.outDir).replaceAll("\\", "/"));
  for (const [what, path] of [
    ["应用入口", entry],
    ["worker 入口", worker],
  ] as const) {
    if (!(await pathExists(path))) fail(`缺少 ${what}：${path}`);
  }
  console.log(`  应用入口 ${entry}`);
  console.log(`  worker 入口 ${worker}（${elapsed(started)}）`);
  return { entry, worker };
}

/**
 * worker 入口：公开的 Vite `build()` API、同一个配置文件的 worker 模式，取**真实产出**里的
 * 入口 chunk —— 文件名来自这次构建实际写出的 chunk，目录来自这次构建自己解析的 outDir。
 *
 * 没有任何文件名约定：worker 模式必须在 `build.ssr` 里声明入口，且必须恰好产出一个入口
 * chunk；能对上 `facadeModuleId` 时还要与声明的入口一致。两个入口必须同目录（序列化器按
 * 「所有入口的公共根目录」给额外入口命名），所以这里顺带核对本次 outDir 与应用构建记录一致。
 */
async function buildWorkerBundle(appOutDir: string): Promise<string> {
  const captured: { outDir?: string; entry?: string } = {};
  const capture: Plugin = {
    name: "r5-worker-build-paths",
    configResolved(config) {
      captured.outDir = resolve(config.root, config.build.outDir).replaceAll("\\", "/");
      captured.entry =
        typeof config.build.ssr === "string" ? resolve(config.root, config.build.ssr).replaceAll("\\", "/") : undefined;
    },
  };
  const result = await viteBuild({ root, mode: "worker", plugins: [capture] });
  const { outDir, entry: declaredEntry } = captured;
  if (outDir === undefined || declaredEntry === undefined) {
    fail("worker 模式没有声明入口：vite.config.ts 的 worker 分支必须在 build.ssr 里给出 worker 入口");
  }
  if (outDir !== appOutDir) {
    fail(`worker 构建的输出目录 ${outDir} 与应用构建记录的 ${appOutDir} 不一致：两个入口必须同目录`);
  }

  const outputs = Array.isArray(result) ? result : [result];
  const entries: { readonly fileName: string; readonly facadeModuleId: string | null }[] = [];
  for (const output of outputs) {
    if (!("output" in output)) continue;
    for (const item of output.output) {
      if (item.type === "chunk" && item.isEntry) {
        entries.push({ fileName: item.fileName, facadeModuleId: item.facadeModuleId });
      }
    }
  }
  const chunk = entries[0];
  if (entries.length !== 1 || chunk === undefined) {
    const names = entries.map((emitted) => emitted.fileName).join("、");
    fail(`worker 构建产出了 ${entries.length} 个入口 chunk（期望 1 个）：${names === "" ? "一个也没有" : names}`);
  }
  if (chunk.facadeModuleId !== null && chunk.facadeModuleId !== declaredEntry) {
    fail(`worker 构建的入口是 ${chunk.fileName}（${chunk.facadeModuleId}），不是 build.ssr 声明的 ${declaredEntry}`);
  }
  return join(outDir, chunk.fileName);
}

/** 公共打包器：准备固定版本原生图 → 序列化入口 → 生成并编译应用 crate → 复核镜像 → 原子发布。 */
async function packageApplication(build: Build, bundles: Bundles): Promise<EmbeddedPackagingReport> {
  const started = phase(2, `打包内嵌应用并发布 ${build.output}`);
  const report = await packageEmbeddedApplication({
    sdkRoot,
    target: build.triple,
    profile: build.profile,
    entry: bundles.entry,
    output: build.output,
    bun: build.serializer,
    application,
    workers: [bundles.worker],
    cacheDir: build.cache,
    ninja: build.ninja,
    ...(build.baseExecutable === undefined ? {} : { baseExecutable: build.baseExecutable }),
    ...(build.sourceSeed === undefined ? {} : { sourceCheckout: build.sourceSeed }),
    ...(build.winsysroot === undefined ? {} : { winsysroot: build.winsysroot }),
    ...(build.macosSdk === undefined ? {} : { macosSdk: build.macosSdk }),
    ...(build.deploymentTarget === undefined ? {} : { deploymentTarget: build.deploymentTarget }),
    onCommand: logCommand,
  });
  console.log(`  已发布 ${report.output}（${elapsed(started)}）`);
  return report;
}

/**
 * 发布结果：身份、摘要与路径全部取自打包器的报告，不再自己解析镜像或图。
 *
 * 报告缺字段只可能是打包器的契约变了：那是内部缺陷，直接停住而不是打印半份摘要。worker
 * 恰好一个也是契约的一部分 —— 打包进镜像的是 `run_packaged` 要用的那个身份。
 */
async function printSummary(build: Build, report: EmbeddedPackagingReport): Promise<void> {
  const { entry, workers, output, sha256, graphSha256 } = report;
  if (
    entry === undefined ||
    workers === undefined ||
    output === undefined ||
    sha256 === undefined ||
    graphSha256 === undefined
  ) {
    fail("打包器没有返回完整的发布报告（entry / workers / graphSha256 / output / sha256）");
  }
  const worker = workers[0];
  if (workers.length !== 1 || worker === undefined) {
    fail(`打包器随镜像序列化了 ${workers.length} 个 worker 入口：run_packaged 只接受一个应用入口加一个 worker`);
  }
  console.log("\n单文件发行版已生成：");
  console.log(`  产物            ${output}`);
  console.log(`  大小 / SHA-256  ${(await stat(output)).size} B / ${sha256}`);
  console.log(`  目标 / 档位     ${report.rustTriple} / ${report.profile}`);
  console.log(`  内嵌图目标      ${report.graphTarget ?? "(无)"}`);
  console.log(`  图负载摘要      ${graphSha256}`);
  console.log(`  应用入口键      ${entry.identity}`);
  console.log(`  worker 入口键   ${worker.identity}`);
  console.log(`  固定版本        Bun ${build.pin.revision}（${build.pin.toolchain}，ninja ${build.pin.ninjaVersion}）`);
  console.log(`  序列化器        ${build.serializer}`);
  if (build.baseExecutable !== undefined) console.log(`  编译基线        ${build.baseExecutable}`);
  console.log(`  原生清单        ${report.artifacts.nativeManifest}`);
  console.log(`  Bun checkout    ${report.artifacts.bunSource}`);
  console.log(`  应用 crate      ${report.artifacts.applicationDirectory}`);
  console.log(`  缓存根          ${build.cache}`);
  console.log(`  上游资格        ${report.qualification}：${report.evidence}`);
}

async function loadWindowsToolchain(): Promise<void> {
  if (process.platform !== "win32" || process.env.VSINSTALLDIR) return;
  const shell = Bun.which("pwsh");
  if (!shell) fail("Windows 内嵌构建需要 PowerShell 7（pwsh）；调用 bun run package 的终端仍可使用 PowerShell 5.1");
  // 只导入开发环境，不让上游 vs-shell.ps1 重新解释 --winsysroot=C:\\... 等参数。
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $installation) { throw 'Visual Studio C++ Build Tools not found' }
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$target = if ($architecture -eq 'Arm64') { 'arm64' } else { 'amd64' }
$launcher = Join-Path $installation 'Common7\Tools\Launch-VsDevShell.ps1'
& $launcher -Arch $target -HostArch amd64 -SkipAutomaticLocation 6>$null | Out-Null
if ($architecture -eq 'Arm64') { $env:PROCESSOR_ARCHITECTURE = 'ARM64' }
[Environment]::GetEnvironmentVariables('Process') | ConvertTo-Json -Compress
`;
  const output = await run(
    [shell, "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    {
      cwd: root,
      stdout: "capture",
    },
  );
  Object.assign(
    process.env,
    stringMapField({ environment: parseJsonObject(output, "Visual Studio 环境") }, "environment", "Visual Studio 环境"),
  );
  if (!process.env.VSINSTALLDIR) fail("Visual Studio 开发环境没有设置 VSINSTALLDIR");
}

async function main(): Promise<void> {
  const build = await createBuild();
  console.log(`目标 ${build.triple}（${build.profile}），构建机 ${process.platform}-${process.arch}`);
  await preflight(build);
  await loadWindowsToolchain();

  const bundles = await bundleApplication();
  const report = await packageApplication(build, bundles);
  await printSummary(build, report);
}

function printUsage(): void {
  console.log(
    [
      "用法：bun run package [--target <rust-triple>] [--profile debug|release]",
      "",
      `  --target    默认 ${defaultTarget}；可选：`,
      "              x86_64-pc-windows-msvc / aarch64-pc-windows-msvc /",
      "              aarch64-apple-darwin / x86_64-apple-darwin",
      "  --profile   release（默认）或 debug；native 用 Bun 的 release /",
      "              debug-no-asan 档，应用 crate 用 cargo 的 release / dev 档",
      "  --help      打印本说明",
      "",
      "两个入口由 vite.config.ts 产出（app 构建 → worker 构建），本命令只做打包。",
      "",
      "环境变量：",
      "  R5_BUILD_BUN                由固定提交构建的 Bun 序列化器（必需，绝对路径）",
      "  R5_BUILD_BASE               目标平台同提交的 Bun 编译基线（跨平台必需，绝对路径）",
      "  R5_BUILD_SOURCE             本地 Bun checkout 种子，省一次源码下载",
      "  R5_BUILD_CACHE              缓存根；Windows 默认 %USERPROFILE%\\.cache\\r5b\\<项目摘要>",
      "  R5_BUILD_NINJA              固定版本 ninja 的位置",
      "  WINDOWS_SYSROOT             交叉编译 Windows 用的 MSVC SDK/CRT 根",
      "  R5_BUILD_MACOS_SDK          macOS SDK（本机用 26.5，27 的头文件与 LLVM 21 不兼容）",
      "  R5_BUILD_DEPLOYMENT_TARGET  macOS 部署目标，与上面的 SDK 一起用",
      "",
      "产物：dist/r5-server.exe（Windows 目标）或 dist/r5-server（macOS 目标）。",
      "上游把这套打包标为实验性：见 vendor/solid-gpui/docs/distribution.md 的目标状态表。",
    ].join("\n"),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof BuildFailure) {
      console.error(`\n构建失败：${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
