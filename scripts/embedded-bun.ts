/**
 * 内嵌打包里「固定版本 Bun」的那一半：源码溯源、原生链接清单、序列化器与模块图。
 *
 * 输入只有固定版本（crates/solid-gpui-bun-sys/bun-build.json）与打包器自己校验过的
 * 产物；这里不写死任何构建机的绝对路径，工具链（ninja、SDK）一律由调用方传入。
 */
import { createHash, type Hash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  type EmbeddedGraph,
  type EmbeddedGraphTarget,
  extractGraphPayload,
  packageEmbeddedGraph,
  parseStandaloneGraph,
} from "../vendor/solid-gpui/scripts/bun-embedded-bundle.ts";
import {
  fail,
  parseJsonObject,
  pathExists,
  run,
  sha256Hex,
  stringField,
  stringListField,
  stringMapField,
} from "./build-support.ts";

/** `bun-build.json`：仓库、提交、rustup 工具链与 ninja 版本。 */
export interface BunPin {
  readonly repository: string;
  readonly revision: string;
  readonly toolchain: string;
  readonly ninjaVersion: string;
}

/** Bun 构建脚本的 `--os` / `--arch`（`--abi` 只在 linux 上有意义）。 */
export interface BuildPlatform {
  readonly os: string;
  readonly arch: string;
  readonly abi?: string;
}

/** 有内嵌应用传输的目标：PE 的 `.bun`、Mach-O 的 `__BUN,__bun`。 */
const GRAPH_TARGETS: Record<string, EmbeddedGraphTarget> = {
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "aarch64-pc-windows-msvc": "bun-windows-arm64",
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
};

const BUN_ARCHES: Record<string, string> = { x86_64: "x64", aarch64: "aarch64", arm64: "aarch64" };
const BUN_OPERATING_SYSTEMS: Record<string, string> = {
  darwin: "darwin",
  windows: "windows",
  linux: "linux",
  freebsd: "freebsd",
  android: "linux",
};

/** 读固定版本信息；revision 必须是完整提交号（打包器用它克隆并反查 HEAD）。 */
export async function readPin(sysRoot: string): Promise<BunPin> {
  const path = join(sysRoot, "bun-build.json");
  const name = basename(path);
  if (!(await pathExists(path))) fail(`缺少固定版本信息：${path}（vendor/solid-gpui 子模块没有初始化？）`);
  const document = parseJsonObject(await readFile(path, "utf8"), name);
  const revision = stringField(document, "revision", `${name}.revision`);
  if (!/^[0-9a-f]{40}$/.test(revision)) fail(`${name}.revision 不是 40 位十六进制提交：${revision}`);
  return {
    repository: stringField(document, "repository", `${name}.repository`),
    revision,
    toolchain: stringField(document, "toolchain", `${name}.toolchain`),
    ninjaVersion: stringField(document, "ninjaVersion", `${name}.ninjaVersion`),
  };
}

/** 目标 triple 对应的内嵌图目标；没有传输方式的目标（如 ELF）在这里就被拒掉。 */
export function graphTargetOf(triple: string): EmbeddedGraphTarget {
  const target = GRAPH_TARGETS[triple];
  if (target === undefined) {
    fail(
      `目标 ${triple} 没有内嵌应用传输：固定版本的打包器只为 ${Object.keys(GRAPH_TARGETS).join("、")} 生成应用镜像。` +
        `Linux 目标在上游只有 --prepare-only（原生准备），本脚本不提供半成品。`,
    );
  }
  return target;
}

/** 从 rust triple 推导 Bun 构建脚本的平台参数。 */
export function buildPlatformOf(triple: string): BuildPlatform {
  const parts = triple.split("-");
  const arch = BUN_ARCHES[parts[0] ?? ""];
  const os = BUN_OPERATING_SYSTEMS[parts[2] ?? ""];
  if (arch === undefined || os === undefined) fail(`无法从这个 rust target 推导 Bun 构建平台：${triple}`);
  const abi = os === "linux" ? parts[3] : undefined;
  return abi === undefined ? { os, arch } : { os, arch, abi };
}

/**
 * 运行构建脚本的 Bun 是否与目标平台一致。
 *
 * 不能时打包器要求给出目标平台的可执行文件当「编译基线」：否则它会去下载一份
 * 该平台、该版本的 Bun，而下载物不受固定提交约束。只有上面那四个图目标会走到这里，
 * 所以不存在 libc ABI 的歧义。
 */
export function platformMatchesProcess(platform: BuildPlatform): boolean {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "arm64" ? "aarch64" : process.arch;
  return platform.os === os && platform.arch === arch;
}

export function executableSuffix(triple: string): string {
  return triple.includes("windows") ? ".exe" : "";
}

/** 序列化器跟随 Bun 的运行架构，Rust 提供平台与 ABI；兼容 ARM64 上运行 x64 Bun。 */
export async function hostTriple(pin: BunPin, cwd: string): Promise<string> {
  const report = await run(["rustup", "run", pin.toolchain, "rustc", "-vV"], {
    cwd,
    stdout: "capture",
    pinnedToolchain: true,
  });
  const host = /^host: (.+)$/m.exec(report)?.[1];
  if (host === undefined) fail(`rustc -vV 没有报告 host（工具链 ${pin.toolchain}）：\n${report}`);
  const architecture = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : undefined;
  if (!architecture) fail(`不支持的构建解释器架构：${process.arch}`);
  return host.replace(/^[^-]+/, architecture);
}

/** 打包器缓存目录名的摘要：pin + 补丁 + embedded overlay（与包装脚本同一算法）。 */
async function preparedSourceDigest(sysRoot: string): Promise<string> {
  const hash = createHash("sha256");
  const name = "bun-build.json";
  hash.update(JSON.stringify(parseJsonObject(await readFile(join(sysRoot, name), "utf8"), name)));
  hash.update(await readFile(join(sysRoot, "bun_embed.patch")));
  await digestTree(join(sysRoot, "embedded"), hash);
  return hash.digest("hex").slice(0, 24);
}

async function digestTree(path: string, hash: Hash): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    hash.update(entry.name);
    const child = join(path, entry.name);
    if (entry.isDirectory()) await digestTree(child, hash);
    else hash.update(await readFile(child));
  }
}

/** 打包器写进 checkout 的标记文件。 */
const SOURCE_MARKER = ".solid-gpui-ready";

/**
 * 复核一个「已准备好的 Bun checkout」，返回它的目录名是否等于本仓库的输入摘要。
 *
 * 目录名只是身份提示，不是证据：换过 pin、补丁或 overlay 的旧缓存必须重建，所以这里
 * 始终按内容复核 —— 标记与 git HEAD 必须是固定提交，补丁必须正是本仓库这一份（反向
 * 试打），三个 overlay 文件必须与本仓库逐字节相同。
 */
async function verifyPreparedSource(path: string, sysRoot: string, pin: BunPin): Promise<boolean> {
  const marker = join(path, SOURCE_MARKER);
  if (!(await pathExists(marker))) fail(`${path} 不是打包器准备好的 Bun checkout：缺少 ${SOURCE_MARKER}`);
  const marked = (await readFile(marker, "utf8")).trim();
  if (marked !== pin.revision) fail(`${path} 是从 Bun ${marked} 准备的，不是固定版本 ${pin.revision}`);

  const head = await run(["git", "rev-parse", "HEAD"], { cwd: path, stdout: "capture", pinnedToolchain: true });
  if (head !== pin.revision) fail(`${path} 的 HEAD 是 ${head}，不是固定版本 ${pin.revision}`);

  const patch = join(sysRoot, "bun_embed.patch");
  try {
    await run(["git", "apply", "--check", "--reverse", patch], { cwd: path, pinnedToolchain: true });
  } catch {
    fail(`${path} 里没有本仓库这一份 bun_embed.patch 的改动：这个 checkout 是用别的补丁准备的，必须重建`);
  }

  const overlays: [string, string][] = [
    [join(sysRoot, "embedded", "runtime.rs"), join(path, "src", "runtime", "embedded.rs")],
    [join(sysRoot, "embedded", "lifecycle.rs"), join(path, "src", "runtime", "embedded", "lifecycle.rs")],
    [join(sysRoot, "embedded", "build", "embed-native.ts"), join(path, "scripts", "build", "embed-native.ts")],
  ];
  for (const [expected, actual] of overlays) {
    const [left, right] = await Promise.all([readFile(expected), readFile(actual)]);
    if (sha256Hex(left) !== sha256Hex(right)) {
      fail(`${actual} 与本仓库的 ${expected} 不一致：这个 checkout 里的 overlay 不是当前 pin 的那一份`);
    }
  }

  const digest = await preparedSourceDigest(sysRoot);
  return basename(path) === `source-${digest}`;
}

export interface PreparedSource {
  readonly path: string;
  /** 本仓库 pin + 补丁 + overlay 的摘要（缓存目录名用的就是它）。 */
  readonly digest: string;
  /** 目录名是否就等于摘要；不是时已由内容证据复核通过。 */
  readonly nameMatched: boolean;
}

/**
 * 定位本次（或既有）准备出来的 Bun checkout。
 *
 * 优先取目录名等于本仓库摘要的那个；否则在缓存里找标记与清单都成立、且内容证据通过的
 * 唯一候选。多个候选互不相让时直接报错，让人去清缓存，而不是猜。
 */
export async function locatePreparedSource(options: {
  readonly cache: string;
  readonly sysRoot: string;
  readonly pin: BunPin;
  readonly buildDirName: string;
}): Promise<PreparedSource> {
  if (!(await pathExists(options.cache))) {
    fail(`缓存目录不存在：${options.cache}。先跑一次正常的准备流程（不带 R5_BUILD_NATIVE_MANIFEST）再复用。`);
  }
  const digest = await preparedSourceDigest(options.sysRoot);
  const expected = join(options.cache, `source-${digest}`);
  if (await hasPreparedManifest(expected, options)) {
    const nameMatched = await verifyPreparedSource(expected, options.sysRoot, options.pin);
    return { path: expected, digest, nameMatched };
  }
  const candidates: string[] = [];
  for (const entry of await readdir(options.cache, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("source-")) continue;
    const path = join(options.cache, entry.name);
    if (await hasPreparedManifest(path, options)) candidates.push(path);
  }
  if (candidates.length === 0) {
    fail(`${options.cache} 里没有固定版本 ${options.pin.revision} 的原生图清单（${options.buildDirName}）`);
  }
  if (candidates.length > 1) {
    fail(
      `${options.cache} 里有多个可用的 Bun checkout，无法确定用哪一个：\n  ${candidates.join("\n  ")}\n` +
        `留一个（或换一个 R5_BUILD_CACHE）后重试。`,
    );
  }
  const [only] = candidates;
  if (only === undefined) fail("缓存里没有可用的 Bun checkout");
  const nameMatched = await verifyPreparedSource(only, options.sysRoot, options.pin);
  console.error(
    `  ! ${only} 的目录名摘要与本仓库 ${digest} 不同，已按标记、补丁与 overlay 内容复核通过：\n` +
      `    这通常是缓存由别的 checkout 准备出来的（pin 相同、补丁文件排版不同）。`,
  );
  return { path: only, digest, nameMatched };
}

async function hasPreparedManifest(path: string, expected: { pin: BunPin; buildDirName: string }): Promise<boolean> {
  const marker = join(path, SOURCE_MARKER);
  if (!(await pathExists(marker))) return false;
  if ((await readFile(marker, "utf8")).trim() !== expected.pin.revision) return false;
  return pathExists(join(path, "build", expected.buildDirName, "embed-native.json"));
}

export interface NativeManifest {
  readonly schemaVersion: number;
  readonly target: string;
  readonly codegenDir: string;
  readonly objects: readonly string[];
  readonly archives: readonly string[];
  readonly linkArgs: readonly string[];
  readonly rustFlags: readonly string[];
  readonly cargoArgs: readonly string[];
  readonly environment: Record<string, string>;
  readonly cargoProfile: string;
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly webkitMode: string;
  readonly buildDir: string;
}

export interface NativeInputs {
  readonly manifest: NativeManifest;
  readonly manifestPath: string;
  /** 已复核过的、清单指向的 Bun checkout（`bun_bin` 与应用 crate 都从它取源码）。 */
  readonly source: string;
}

/**
 * 跑打包器的 `--prepare-only`：配置并构建固定版本 Bun 的原生图。
 *
 * `--prepare-only` 不读 `--bun`（它不构建应用），但仍要求给出三个必需参数 —— 这里传的是
 * 真正会用到的入口与输出，以及当前解释器，免得这些参数在日志里变成假信息。
 */
export async function prepareNativeGraph(options: {
  readonly vendorRoot: string;
  readonly workspace: string;
  readonly pin: BunPin;
  readonly interpreter: string;
  readonly entry: string;
  readonly output: string;
  readonly buildDirName: string;
  readonly profile: string;
  readonly target: string;
  readonly cache: string;
  readonly ninja: string;
  readonly sourceSeed?: string;
  readonly winsysroot?: string;
  readonly macosSdk?: string;
}): Promise<void> {
  const script = join(options.vendorRoot, "scripts", "bun-static-package.ts");
  if (!(await pathExists(script))) fail(`缺少打包驱动：${script}（vendor/solid-gpui 子模块没有初始化？）`);
  await run(
    [
      options.interpreter,
      script,
      "--entry",
      options.entry,
      "--bun",
      options.interpreter,
      "--output",
      options.output,
      "--target",
      options.target,
      "--profile",
      options.profile,
      "--cache",
      options.cache,
      ...(options.sourceSeed === undefined ? [] : ["--source", options.sourceSeed]),
      "--ninja",
      options.ninja,
      ...(options.winsysroot === undefined ? [] : ["--winsysroot", options.winsysroot]),
      ...(options.macosSdk === undefined ? [] : [`--macos-sdk=${resolve(options.macosSdk)}`]),
      "--prepare-only",
    ],
    { cwd: options.workspace, env: { RUSTUP_TOOLCHAIN: options.pin.toolchain }, pinnedToolchain: true },
  );
}

/** 逐项校验 `embed-native.json`：它是应用 crate 唯一的链接契约，错一项就必须停。 */
export async function readNativeInputs(options: {
  readonly manifestPath: string;
  readonly triple: string;
  readonly profile: string;
  readonly pin: BunPin;
  readonly sysRoot: string;
  readonly buildDirName: string;
  /** 已知的、已复核过的 checkout；为 null 时从清单的 buildDir 推导（复用别人的清单）。 */
  readonly source: string | null;
}): Promise<NativeInputs> {
  const manifestPath = resolve(options.manifestPath);
  const document = parseJsonObject(await readFile(manifestPath, "utf8"), basename(manifestPath));

  const schemaVersion = document.schemaVersion;
  if (schemaVersion !== 1) fail(`原生清单的 schemaVersion 是 ${JSON.stringify(schemaVersion)}，本脚本只认识 1`);
  const target = stringField(document, "target", "target");
  if (target !== options.triple) fail(`原生清单是为 ${target} 构建的，当前目标却是 ${options.triple}`);
  const cargoProfile = stringField(document, "cargoProfile", "cargoProfile");
  const expectedProfile = options.profile === "release" ? "release" : "dev";
  if (cargoProfile !== expectedProfile) {
    fail(`原生清单的 cargo profile 是 ${cargoProfile}，不是 --profile ${options.profile} 对应的 ${expectedProfile}`);
  }
  const bunRevision = stringField(document, "bunRevision", "bunRevision");
  if (bunRevision !== options.pin.revision) {
    fail(`原生清单由 Bun ${bunRevision} 构建，不是固定版本 ${options.pin.revision}`);
  }
  const webkitMode = stringField(document, "webkitMode", "webkitMode");
  if (webkitMode !== "prebuilt") fail(`原生清单的 WebKit 模式是 ${webkitMode}，只接受预编译产物 prebuilt`);

  const buildDir = stringField(document, "buildDir", "buildDir");
  const codegenDir = stringField(document, "codegenDir", "codegenDir");
  const objects = stringListField(document, "objects", "objects");
  const archives = stringListField(document, "archives", "archives");
  const linkArgs = stringListField(document, "linkArgs", "linkArgs");
  const rustFlags = stringListField(document, "rustFlags", "rustFlags");
  const cargoArgs = stringListField(document, "cargoArgs", "cargoArgs");
  const environment = stringMapField(document, "environment", "environment");

  if (basename(buildDir) !== options.buildDirName) {
    fail(`原生清单的构建目录是 ${buildDir}，与打包器约定的 ${options.buildDirName} 不符`);
  }
  for (const path of [buildDir, codegenDir]) {
    if (!isAbsolute(path)) fail(`原生清单里的 ${path} 不是绝对路径`);
  }
  const listed = [...objects, ...archives];
  for (const path of listed) {
    if (!isAbsolute(path)) fail(`原生清单里的 ${path} 不是绝对路径`);
  }
  for (const path of [codegenDir, ...listed]) {
    if (!(await pathExists(path))) {
      fail(
        `原生清单指向的文件不存在：${path}\n` +
          `  清单过期（构建目录被清理过），或这个构建目录的 ninja 还没跑完。` +
          `跑一次正常流程（不带 R5_BUILD_NATIVE_MANIFEST）会重新配置并补齐缺失的目标。`,
      );
    }
  }
  const staticlib = archives.find((path) => /(?:^|\/)lib?bun_rust\.(?:a|lib)$/.test(path));
  if (staticlib !== undefined) {
    fail(`原生清单带了单独编译的 Bun Rust 静态库（${staticlib}）：应用必须与 bun_bin 共享同一张 crate 图`);
  }

  const source = options.source ?? resolve(buildDir, "..", "..");
  for (const required of [join(source, "scripts", "build.ts"), join(source, "src", "bun_bin", "Cargo.toml")]) {
    if (!(await pathExists(required))) {
      fail(`原生清单的构建目录不在一个已准备好的 Bun checkout 里（缺少 ${required}）`);
    }
  }
  const nameMatched = await verifyPreparedSource(source, options.sysRoot, options.pin);
  if (!nameMatched) {
    console.error(`  ! ${source} 的目录名摘要与本仓库不一致，已按内容复核通过（见上文说明）`);
  }

  return {
    manifest: {
      schemaVersion,
      target,
      codegenDir,
      objects,
      archives,
      linkArgs,
      rustFlags,
      cargoArgs,
      environment,
      cargoProfile,
      bunVersion: stringField(document, "bunVersion", "bunVersion"),
      bunRevision,
      webkitMode,
      buildDir: resolve(buildDir),
    },
    manifestPath,
    source,
  };
}

/**
 * 固定版本的 bun 可执行文件：序列化器（跑在构建机上）或跨平台编译基线。
 *
 * 未给覆盖时从同一份已准备的 checkout 现场构建（bun 自己的 `scripts/build.ts` +
 * ninja），这样两边的提交、补丁与 WebKit 模式完全一致；**绝不会**去下载一份不受
 * 固定提交约束的 Bun。
 */
export async function ensurePinnedBunExecutable(options: {
  readonly role: "serializer" | "base";
  readonly source: string;
  readonly pin: BunPin;
  readonly interpreter: string;
  readonly profile: string;
  readonly triple: string;
  readonly platform: BuildPlatform;
  readonly ninja: string;
  readonly override?: string;
  readonly winsysroot?: string;
  readonly macosSdk?: string;
}): Promise<string> {
  const suffix = executableSuffix(options.triple);
  if (options.override !== undefined) {
    if (!isAbsolute(options.override)) {
      fail(`${options.role === "serializer" ? "R5_BUILD_BUN" : "R5_BUILD_BASE"} 必须是绝对路径：${options.override}`);
    }
    const path = resolve(options.override);
    if (!(await pathExists(path))) {
      fail(`${options.role === "serializer" ? "R5_BUILD_BUN" : "R5_BUILD_BASE"} 指向的文件不存在：${path}`);
    }
    return path;
  }

  const buildDir = join(options.source, "build", `${options.role}-${options.triple}-${options.profile}`);
  // 序列化器是构建期工具：用与目标相同的 profile 构建，一次 --profile 决定整条链路。
  const buildProfile = options.profile === "debug" ? "debug-no-asan" : "release";
  await run(
    [
      options.interpreter,
      "scripts/build.ts",
      `--profile=${buildProfile}`,
      `--os=${options.platform.os}`,
      `--arch=${options.platform.arch}`,
      ...(options.platform.abi === undefined ? [] : [`--abi=${options.platform.abi}`]),
      ...(options.winsysroot === undefined || options.platform.os !== "windows"
        ? []
        : [`--winsysroot=${resolve(options.winsysroot)}`]),
      ...(options.macosSdk === undefined || options.platform.os !== "darwin"
        ? []
        : [`--macos-sdk=${resolve(options.macosSdk)}`]),
      "--webkit=prebuilt",
      "--configure-only",
      "--build-dir",
      buildDir,
    ],
    { cwd: options.source, env: { RUSTUP_TOOLCHAIN: options.pin.toolchain }, pinnedToolchain: true },
  );
  await run([options.ninja, "-C", buildDir, "bun"], {
    cwd: options.source,
    env: { RUSTUP_TOOLCHAIN: options.pin.toolchain },
    pinnedToolchain: true,
  });

  // 名字随 profile 变（release 是 strip 后的 `bun`，debug 是 `bun-debug`）：按已知输出
  // 依次找，找不到就列出目录内容，不做「随便挑一个可执行文件」的猜测。
  const names = [`bun${suffix}`, `bun-debug${suffix}`, `bun-profile${suffix}`];
  const present: string[] = [];
  for (const name of names) {
    const path = join(buildDir, name);
    if (await pathExists(path)) present.push(path);
  }
  const found = present[0];
  if (found === undefined) {
    const entries = (await readdir(buildDir)).toSorted().join("、");
    fail(`${buildDir} 里没有 bun 可执行文件（期望 ${names.join(" / ")}）；目录内容：${entries}`);
  }
  return found;
}

/** 打包器写进 `<outDir>` 的 section 字节文件名（见 bun-embedded-bundle.ts 的同名常量）。 */
const SECTION_BYTES = "bun-embedded-graph.bin";

export interface ApplicationGraph {
  readonly rustSource: string;
  readonly sectionBytes: string;
  /** 应用入口的图键，交给 `run_packaged` 的第一参数。 */
  readonly entry: string;
  /** worker 入口的图键，交给 `run_packaged` 的第二参数。 */
  readonly worker: string;
  /** 序列化负载（不含 8 字节长度头）的 SHA-256。 */
  readonly sha256: string;
  readonly target: EmbeddedGraphTarget;
}

/**
 * 把已构建的应用入口与 worker 序列化成一个模块图。
 *
 * 返回的两个图键都是**图里实际存在**的键，而不是猜出来的路径：运行时按键精确查找，
 * 一个「看起来像」的键等于启动失败。
 */
export async function packageApplicationGraph(options: {
  readonly serializer: string;
  readonly entry: string;
  readonly worker: string;
  readonly target: EmbeddedGraphTarget;
  readonly outDir: string;
  readonly baseExecutable?: string;
}): Promise<ApplicationGraph> {
  const packaged = await packageEmbeddedGraph({
    bun: options.serializer,
    entry: options.entry,
    target: options.target,
    outDir: options.outDir,
    workers: [options.worker],
    ...(options.baseExecutable === undefined ? {} : { baseExecutable: options.baseExecutable }),
  });
  const sectionBytes = join(options.outDir, SECTION_BYTES);
  const rustSource = await readFile(packaged.rustSource, "utf8");
  if (!rustSource.includes(JSON.stringify(SECTION_BYTES))) {
    fail(`生成的应用 crate 没有引用 ${SECTION_BYTES}：打包器的产物布局变了，本脚本的读数假设已失效`);
  }

  const section = await readFile(sectionBytes);
  const declared = new DataView(section.buffer, section.byteOffset, 8).getBigUint64(0, true);
  const payload = section.subarray(8);
  if (Number(declared) !== payload.length) {
    fail(`${sectionBytes} 的长度头声明 ${declared} 字节，实际负载 ${payload.length} 字节`);
  }
  const sha256 = sha256Hex(payload);
  if (sha256 !== packaged.graphSha256) {
    fail(`序列化负载的摘要是 ${sha256}，与打包器校验过的 ${packaged.graphSha256} 不一致`);
  }

  const graph = parseStandaloneGraph(payload, options.target);
  if (graph.entry !== packaged.entry) fail(`图里的入口键 ${graph.entry} 与打包器返回的 ${packaged.entry} 不一致`);
  const entryName = basename(options.entry);
  if (!graph.entry.endsWith(entryName)) fail(`入口键 ${graph.entry} 不以入口文件名 ${entryName} 结尾`);

  return {
    rustSource: packaged.rustSource,
    sectionBytes,
    entry: graph.entry,
    worker: workerIdentity(graph, basename(options.worker)),
    sha256,
    target: options.target,
  };
}

/**
 * worker 的图键。
 *
 * 序列化器把额外入口键成「相对所有入口的公共根目录」的路径：两个入口在同一目录（本仓库
 * 的 `native/target/bundles`）时就是文件名本身，这也是打包器注释写明的规则。若哪天两者
 * 不同目录，就退回「图里除了入口只有一项、且文件名正是该 worker」这一判据；再对不上就
 * 列全部图键报错，不做任何猜测。
 */
function workerIdentity(graph: EmbeddedGraph, workerName: string): string {
  const keys = graph.files.map((file) => file.name);
  const coLocated = `${graph.entry.slice(0, graph.entry.length - basename(graph.entry).length)}${workerName}`;
  if (keys.includes(coLocated)) return coLocated;
  const others = keys.filter((key) => key !== graph.entry);
  const [only] = others;
  if (others.length === 1 && only !== undefined && basename(only) === workerName) return only;
  return fail(
    `图里找不到 ${workerName} 的入口键（应用入口 ${graph.entry}）：额外入口的键要么与入口同目录` +
      `（${coLocated}），要么是图里唯一的另一项。图里的键：\n  ${keys.join("\n  ")}`,
  );
}

/** 从最终镜像里重新取图：这一步同时证明 section 逐字节存活、机器类型正确。 */
export async function verifyImageGraph(
  image: Uint8Array,
  expected: {
    readonly target: EmbeddedGraphTarget;
    readonly sha256: string;
    readonly entry: string;
    readonly worker: string;
  },
): Promise<readonly string[]> {
  const payload = extractGraphPayload(image, expected.target);
  const sha256 = sha256Hex(payload);
  if (sha256 !== expected.sha256) {
    fail(`最终镜像里的图负载摘要是 ${sha256}，与校验过的 ${expected.sha256} 不一致（section 被丢弃或改写了）`);
  }
  const graph = parseStandaloneGraph(payload, expected.target);
  if (graph.entry !== expected.entry) fail(`最终镜像的入口键是 ${graph.entry}，不是 ${expected.entry}`);
  for (const identity of [expected.entry, expected.worker]) {
    if (!graph.files.some((file) => file.name === identity)) {
      fail(`最终镜像的图里缺少入口 ${identity}：应用与 worker 必须一起被序列化进同一个镜像`);
    }
  }
  return graph.files.map((file) => file.name);
}
