#!/usr/bin/env bun
/**
 * 一条命令打出真正的单文件发行版：`dist/r5-server.exe`。
 *
 * 一个可执行文件里同时装着 GPUI 宿主、Bun/JSC 运行时、序列化后的前端 JS 与 worker
 * 入口，运行期不需要相邻的 Bun、`node_modules` 或任何 JS 目录树。全程只有最后一步
 * 会写 `dist/`：中间 JS 在 `native/target/bundles`（vite 的输出目录），原生图与应用
 * crate 在平台构建缓存；Windows 使用按项目隔离的短路径，避免 cmd/Ninja 的路径限制。
 *
 * 流程：vite 打前端 → Bun.build 打 worker → 打包器 `--prepare-only` 准备固定版本 Bun
 * 的原生图 → 复核溯源并确定序列化器（跨平台时还要编译基线）→ 序列化「应用 + worker」
 * → 生成应用 crate 并编译 → 从最终镜像里重新取图核对，再原子发布。
 *
 * 环境变量全部可选（不设时由固定版本与本仓库布局推导）：`R5_BUILD_BUN` 固定提交的
 * Bun（序列化器）、`R5_BUILD_BASE` 目标平台同提交的 Bun（编译基线）、`R5_BUILD_SOURCE`
 * 本地 Bun checkout 种子、`R5_BUILD_NATIVE_MANIFEST` 复用既有原生清单、`R5_BUILD_CACHE`
 * 缓存根、`R5_BUILD_NINJA` ninja、`R5_BUILD_MACOS_SDK` macOS SDK、`WINDOWS_SYSROOT`。
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { EmbeddedGraphTarget } from "../vendor/solid-gpui/scripts/bun-embedded-bundle.ts";
import { BuildFailure, fail, parseJsonObject, pathExists, run, sha256Hex, stringMapField } from "./build-support.ts";
import {
  type BunPin,
  buildPlatformOf,
  ensurePinnedBunExecutable,
  executableSuffix,
  graphTargetOf,
  hostTriple,
  locatePreparedSource,
  type NativeInputs,
  packageApplicationGraph,
  platformMatchesProcess,
  prepareNativeGraph,
  readNativeInputs,
  readPin,
  verifyImageGraph,
} from "./embedded-bun.ts";
import { buildCrate, generateCrate } from "./embedded-crate.ts";

const root = resolve(import.meta.dirname, "..");
const vendorRoot = join(root, "vendor", "solid-gpui");
const sysRoot = join(vendorRoot, "crates", "solid-gpui-bun-sys");
/** 构建中间物（vite 的输出目录）。发布产物只放 dist/，见 output。 */
const bundles = join(root, "native", "target", "bundles");
const appBundle = join(bundles, "app.js");
const workerBundle = join(bundles, "worker.js");
const workerEntry = join(root, "src", "worker-entry.ts");
const defaultTarget = "x86_64-pc-windows-msvc";
const phaseCount = 8;

interface Build {
  readonly pin: BunPin;
  readonly triple: string;
  readonly profile: "debug" | "release";
  readonly graphTarget: EmbeddedGraphTarget;
  readonly output: string;
  readonly host: string;
  readonly cache: string;
  readonly appDirectory: string;
  readonly buildDirName: string;
  readonly ninja: string;
  readonly serializerOverride?: string;
  readonly baseOverride?: string;
  readonly sourceSeed?: string;
  readonly reuseManifest?: string;
  readonly winsysroot?: string;
  readonly macosSdk?: string;
}

interface Summary {
  readonly build: Build;
  readonly manifestPath: string;
  readonly source: string;
  readonly serializer: string;
  readonly baseExecutable?: string;
  readonly entry: string;
  readonly worker: string;
  readonly graphSha256: string;
}

function override(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function phase(step: number, title: string): number {
  console.log(`\n[${step}/${phaseCount}] ${title}`);
  return Bun.nanoseconds();
}

function elapsed(started: number): string {
  return `${((Bun.nanoseconds() - started) / 1e9).toFixed(1)}s`;
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
  const pin = await readPin(sysRoot);
  const defaultCache =
    process.platform === "win32"
      ? join(homedir(), ".cache", "r5b", sha256Hex(root).slice(0, 12))
      : join(root, "native", "target", "bun-static");
  const cache = resolve(override("R5_BUILD_CACHE") ?? defaultCache);
  const ninja = override("R5_BUILD_NINJA") ?? Bun.which("ninja");
  if (ninja === null || ninja === undefined) {
    fail(`找不到 ninja（固定版本要求 ${pin.ninjaVersion}）：装一个，或用 R5_BUILD_NINJA 指到可执行文件`);
  }
  return {
    pin,
    triple,
    profile,
    graphTarget: graphTargetOf(triple),
    output: join(root, "dist", `r5-server${executableSuffix(triple)}`),
    host: await hostTriple(pin, root),
    cache,
    appDirectory: join(cache, "application", `${triple}-${profile}`),
    // 打包器自己的构建目录命名（它把同一路径写进清单的 buildDir）：用来定位它刚准备出来的产物。
    buildDirName: `solid-gpui-${triple}-${profile}`,
    ninja,
    serializerOverride: override("R5_BUILD_BUN"),
    baseOverride: override("R5_BUILD_BASE"),
    sourceSeed: override("R5_BUILD_SOURCE"),
    reuseManifest: override("R5_BUILD_NATIVE_MANIFEST"),
    winsysroot: override("WINDOWS_SYSROOT"),
    macosSdk: override("R5_BUILD_MACOS_SDK"),
  };
}

/**
 * 前置检查：全部在做任何重活之前跑完，且每一处失败都给出可执行的下一步。
 *
 * 这里只查「能不能开始」：仓库输入齐不齐、固定工具链在不在、ninja 在不在、显式覆盖
 * 的文件在不在。真正的契约校验（清单、图、镜像）在各阶段自己完成。
 */
async function preflight(build: Build): Promise<void> {
  const inputs = [
    join(sysRoot, "bun_embed.patch"),
    join(vendorRoot, "scripts", "bun-static-package.ts"),
    join(vendorRoot, "Cargo.toml"),
    join(root, "native", "Cargo.toml"),
    join(root, "native", "src", "lib.rs"),
    workerEntry,
  ];
  for (const path of inputs) {
    if (!(await pathExists(path))) fail(`缺少构建输入：${path}`);
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
  for (const triple of [build.host, build.triple]) {
    if (!installed.has(triple)) {
      fail(`固定工具链缺少 ${triple} 的标准库：rustup target add ${triple} --toolchain ${build.pin.toolchain}`);
    }
  }
  if (build.profile === "release") {
    // 发布档按原生清单的 cargoArgs 用 -Zbuild-std 重编 std：没有 rust-src 组件必然失败。
    const sysroot = await run([rustup, "run", build.pin.toolchain, "rustc", "--print", "sysroot"], options);
    if (!(await pathExists(join(sysroot, "lib", "rustlib", "src", "rust", "library")))) {
      fail(`发布档需要 rust-src 组件：rustup component add rust-src --toolchain ${build.pin.toolchain}`);
    }
  }
  for (const [name, value] of [
    ["R5_BUILD_BUN", build.serializerOverride],
    ["R5_BUILD_BASE", build.baseOverride],
    ["R5_BUILD_NATIVE_MANIFEST", build.reuseManifest],
    ["WINDOWS_SYSROOT", build.winsysroot],
    ["R5_BUILD_MACOS_SDK", build.macosSdk],
  ] as const) {
    if (value !== undefined && !(await pathExists(resolve(value)))) fail(`${name} 指向的路径不存在：${value}`);
  }
  if (build.sourceSeed !== undefined && !(await pathExists(join(resolve(build.sourceSeed), "scripts", "build.ts")))) {
    fail(`R5_BUILD_SOURCE 不是 Bun 源码 checkout（缺少 scripts/build.ts）：${build.sourceSeed}`);
  }
}

/**
 * 前端包：跑既有的 `gui:build`（vite，输出到 native/target/bundles）。
 *
 * 先删掉旧的 app.js 再构建：vite 会清空自己的输出目录，但产物本身缺失就无法蒙混过关。
 */
async function bundleApplication(): Promise<void> {
  const started = phase(1, "打包前端（bun run gui:build → app.js）");
  await rm(appBundle, { force: true });
  // `gui:build` 自己再进一次 `bun`：把 PATH 顶到本进程的解释器，避免用到另一个 Bun。
  const bunDirectory = dirname(process.execPath);
  const inheritedPath = process.env.PATH;
  await run([process.execPath, "run", "gui:build"], {
    cwd: root,
    env: { PATH: inheritedPath === undefined ? bunDirectory : `${bunDirectory}${delimiter}${inheritedPath}` },
  });
  if (!(await pathExists(appBundle))) {
    fail(`前端构建没有产出 ${appBundle}：检查 vite.config.ts 的 entry 与 build.outDir`);
  }
  console.log(`  app.js（${elapsed(started)}）`);
}

/**
 * worker 入口：Bun.build 打成单文件 ESM。
 *
 * 必须排在 vite 之后（它清空输出目录，会顺手删掉 worker.js），也排在
 * `src/generated/native.ts` 生成之后（`@solid-gpui/core/components` 指向它）。这里不走
 * Solid 的 JSX 变换：worker 是纯 TS，引入 `.tsx` 就会用 Bun 默认的 JSX 运行时，运行时必炸
 * —— 所以直接拒绝，而不是让它在最终镜像里才暴露。
 */
async function bundleWorker(): Promise<void> {
  const started = phase(2, "打包 worker（Bun.build → worker.js）");
  await rm(workerBundle, { force: true });
  let success = false;
  let logs: string[] = [];
  try {
    const result = await Bun.build({
      entrypoints: [workerEntry],
      outdir: bundles,
      naming: { entry: "worker.js" },
      target: "bun",
      format: "esm",
      conditions: ["browser"],
      sourcemap: "none",
      // 运行期环境变量（R5_SERVER_ROOT 等）必须留到运行时读：禁止把构建机的值内联进去。
      env: "disable",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      plugins: [
        {
          name: "r5-worker-no-jsx",
          setup(build) {
            build.onLoad({ filter: /\.[jt]sx$/ }, (args) => {
              throw new Error(`worker 不能引入 JSX 模块：${args.path}`);
            });
          },
        },
      ],
    });
    success = result.success;
    logs = result.logs.map((log) => `  ${log.level}: ${log.message}`);
  } catch (error) {
    logs = bundleMessages(error);
  }
  if (!success) {
    for (const log of logs) console.error(log);
    fail("worker 打包失败");
  }
  if (!(await pathExists(workerBundle))) fail(`worker 打包没有产出 ${workerBundle}`);
  console.log(`  worker.js（${elapsed(started)}）`);
}

/** 取出 Bun.build 失败时挂出来的消息（AggregateError 的 `errors`）。 */
function bundleMessages(error: unknown): string[] {
  if (typeof error === "object" && error !== null && "errors" in error && Array.isArray(error.errors)) {
    const messages: string[] = [];
    for (const entry of error.errors) messages.push(entry instanceof Error ? entry.message : String(entry));
    if (messages.length > 0) return messages;
  }
  return [error instanceof Error ? error.message : String(error)];
}

/** 原生图：跑打包器的 `--prepare-only`，或只读复用一份已准备好的清单。 */
async function prepareNative(build: Build): Promise<NativeInputs> {
  const started = phase(3, "准备固定版本 Bun 的原生图（bun-static-package --prepare-only）");
  let source: string | null = null;
  let manifestPath: string;
  if (build.reuseManifest === undefined) {
    await prepareNativeGraph({
      vendorRoot,
      workspace: root,
      pin: build.pin,
      interpreter: process.execPath,
      entry: appBundle,
      output: build.output,
      buildDirName: build.buildDirName,
      profile: build.profile,
      target: build.triple,
      cache: build.cache,
      ninja: build.ninja,
      ...(build.sourceSeed === undefined ? {} : { sourceSeed: build.sourceSeed }),
      ...(build.winsysroot === undefined ? {} : { winsysroot: build.winsysroot }),
      ...(build.macosSdk === undefined ? {} : { macosSdk: build.macosSdk }),
    });
    source = (
      await locatePreparedSource({ cache: build.cache, sysRoot, pin: build.pin, buildDirName: build.buildDirName })
    ).path;
    manifestPath = join(source, "build", build.buildDirName, "embed-native.json");
  } else {
    manifestPath = build.reuseManifest;
  }
  const inputs = await readNativeInputs({
    manifestPath,
    triple: build.triple,
    profile: build.profile,
    pin: build.pin,
    sysRoot,
    buildDirName: build.buildDirName,
    source,
  });
  console.log(`  ${inputs.manifestPath}（${elapsed(started)}）`);
  return inputs;
}

/** 序列化器与（跨平台时的）编译基线：优先用显式覆盖，否则从同一份 checkout 现场构建。 */
async function resolveExecutables(
  build: Build,
  source: string,
): Promise<{ serializer: string; baseExecutable?: string }> {
  const started = phase(4, "确定固定版本的序列化器与编译基线");
  const serializer = await ensurePinnedBunExecutable({
    role: "serializer",
    source,
    pin: build.pin,
    interpreter: process.execPath,
    profile: build.profile,
    triple: build.host,
    platform: buildPlatformOf(build.host),
    ninja: build.ninja,
    ...(build.serializerOverride === undefined ? {} : { override: build.serializerOverride }),
    ...(build.winsysroot === undefined ? {} : { winsysroot: build.winsysroot }),
    ...(build.macosSdk === undefined ? {} : { macosSdk: build.macosSdk }),
  });
  const platform = buildPlatformOf(build.triple);
  let baseExecutable: string | undefined;
  if (build.baseOverride !== undefined || !platformMatchesProcess(platform)) {
    // 序列化器跑不到目标平台：必须有一份目标平台、同提交的 Bun 当编译基线，否则打包器
    // 会去下载一份不受固定提交约束的 Bun（上游直接拒绝，这里同样不提供下载路径）。
    baseExecutable = await ensurePinnedBunExecutable({
      role: "base",
      source,
      pin: build.pin,
      interpreter: process.execPath,
      profile: build.profile,
      triple: build.triple,
      platform,
      ninja: build.ninja,
      ...(build.baseOverride === undefined ? {} : { override: build.baseOverride }),
      ...(build.winsysroot === undefined ? {} : { winsysroot: build.winsysroot }),
      ...(build.macosSdk === undefined ? {} : { macosSdk: build.macosSdk }),
    });
  }
  console.log(`  序列化器 ${serializer}（${elapsed(started)}）`);
  if (baseExecutable !== undefined) console.log(`  编译基线 ${baseExecutable}`);
  return baseExecutable === undefined ? { serializer } : { serializer, baseExecutable };
}

/** 原子发布：先写同目录临时文件，再改名覆盖；失败时不留半成品。 */
async function publish(image: Uint8Array, output: string): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  const temporary = join(dirname(output), `.${basename(output)}.${randomUUID()}`);
  try {
    await writeFile(temporary, image);
    await chmod(temporary, 0o755);
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function printSummary(summary: Summary, size: number, digest: string): void {
  const { build } = summary;
  console.log("\n单文件发行版已生成：");
  console.log(`  产物            ${build.output}`);
  console.log(`  目标 / 档位     ${build.triple} / ${build.profile}`);
  console.log(`  大小 / SHA-256  ${size} B / ${digest}`);
  console.log(`  图入口          ${summary.entry}`);
  console.log(`  worker 入口     ${summary.worker}`);
  console.log(`  图负载摘要      ${summary.graphSha256}`);
  console.log(`  固定版本        Bun ${build.pin.revision}（${build.pin.toolchain}，ninja ${build.pin.ninjaVersion}）`);
  console.log(`  序列化器        ${summary.serializer}`);
  if (summary.baseExecutable !== undefined) console.log(`  编译基线        ${summary.baseExecutable}`);
  console.log(`  原生清单        ${summary.manifestPath}`);
  console.log(`  Bun checkout    ${summary.source}`);
  console.log(`  缓存根          ${build.cache}`);
  console.log(`  应用工程        ${build.appDirectory}`);
  if (build.macosSdk !== undefined) console.log(`  macOS SDK       ${build.macosSdk}`);
  console.log(`  中间 JS         ${bundles}`);
}

async function loadWindowsToolchain(): Promise<void> {
  if (process.platform !== "win32" || process.env.VSINSTALLDIR) return;
  const shell = Bun.which("pwsh");
  if (!shell) fail("Windows 内嵌构建需要 PowerShell 7（pwsh）；调用 bun run build 的终端仍可使用 PowerShell 5.1");
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
  console.log(`目标 ${build.triple}（${build.profile}），构建机 ${build.host}`);
  await preflight(build);
  await loadWindowsToolchain();

  await bundleApplication();
  await bundleWorker();
  const native = await prepareNative(build);
  const { serializer, baseExecutable } = await resolveExecutables(build, native.source);

  const graphStarted = phase(5, "序列化模块图（应用入口 + worker）");
  const graph = await packageApplicationGraph({
    serializer,
    entry: appBundle,
    worker: workerBundle,
    target: build.graphTarget,
    outDir: join(build.appDirectory, "graph"),
    ...(baseExecutable === undefined ? {} : { baseExecutable }),
  });
  console.log(`  图负载 ${graph.sha256}（${elapsed(graphStarted)}）`);

  const crateStarted = phase(6, "生成应用 crate（Cargo.toml / build.rs / main.rs）");
  await generateCrate({
    directory: build.appDirectory,
    repositoryRoot: root,
    vendorRoot,
    source: native.source,
    manifest: native.manifest,
    manifestPath: native.manifestPath,
    graphRustSource: graph.rustSource,
    workerIdentity: graph.worker,
  });
  console.log(`  ${build.appDirectory}（${elapsed(crateStarted)}）`);

  const linkStarted = phase(7, "链接最终可执行文件（cargo build）");
  const executable = await buildCrate({
    directory: build.appDirectory,
    manifest: native.manifest,
    manifestPath: native.manifestPath,
    pin: build.pin,
  });
  console.log(`  ${executable}（${elapsed(linkStarted)}）`);

  const publishStarted = phase(8, `校验并发布 ${build.output}`);
  const image = await readFile(executable);
  const keys = await verifyImageGraph(image, {
    target: build.graphTarget,
    sha256: graph.sha256,
    entry: graph.entry,
    worker: graph.worker,
  });
  console.log(`  镜像内图键 ${keys.length} 个，入口与机器类型均符合 ${build.graphTarget}`);
  await publish(image, build.output);
  console.log(`  已发布 ${build.output}（${elapsed(publishStarted)}）`);
  printSummary(
    {
      build,
      manifestPath: native.manifestPath,
      source: native.source,
      serializer,
      ...(baseExecutable === undefined ? {} : { baseExecutable }),
      entry: graph.entry,
      worker: graph.worker,
      graphSha256: graph.sha256,
    },
    image.length,
    sha256Hex(image),
  );
}

function printUsage(): void {
  console.log(
    [
      "用法：bun run build [--target <rust-triple>] [--profile debug|release]",
      "",
      `  --target    默认 ${defaultTarget}；可选：`,
      "              x86_64-pc-windows-msvc / aarch64-pc-windows-msvc /",
      "              aarch64-apple-darwin / x86_64-apple-darwin",
      "  --profile   release（默认）或 debug；两个档位分别用 Bun 的 release /",
      "              debug-no-asan 原生档与 cargo 的 release / dev 档",
      "  --help      打印本说明",
      "",
      "环境变量（可选）：R5_BUILD_BUN、R5_BUILD_BASE、R5_BUILD_SOURCE、",
      "R5_BUILD_NATIVE_MANIFEST、R5_BUILD_CACHE、R5_BUILD_NINJA、R5_BUILD_MACOS_SDK、",
      "WINDOWS_SYSROOT。",
      "产物：dist/r5-server.exe（Windows 目标）或 dist/r5-server（macOS 目标）。",
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
