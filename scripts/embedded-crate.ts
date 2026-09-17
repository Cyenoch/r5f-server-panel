/**
 * 内嵌应用 crate：把原生链接清单、序列化后的模块图与宿主库拼成一个可执行文件。
 *
 * 生成的工程放在缓存目录里（不进版本库）：目录里没有手写代码，全部内容都由本模块
 * 与打包器产物决定。Cargo.toml 的 profile 取固定版本 Bun 的那一份 —— 原生半成品
 * 就是按同一套 cargo 策略编译出来的，编译基线与 WebKit 预编译产物也只与那一套一致。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fail, pathExists, run, stringField } from "./build-support.ts";
import { type BunPin, executableSuffix, type NativeManifest } from "./embedded-bun.ts";

/** 只声明本模块真正会读取的部分；其余字段原样保留（尤其是 profile / patch）。 */
interface TomlDocument {
  package?: Record<string, unknown>;
  profile?: Record<string, Record<string, unknown>>;
  patch?: Record<string, Record<string, Record<string, unknown>>>;
}

function parseToml(text: string, what: string): TomlDocument {
  try {
    return Bun.TOML.parse(text);
  } catch (error) {
    return fail(`${what} 不是合法 TOML：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 内容不变就不落盘：无谓地刷新时间戳会让 cargo 重新编译并重链。 */
async function writeIfChanged(path: string, content: string): Promise<void> {
  if ((await pathExists(path)) && (await readFile(path, "utf8")) === content) return;
  await writeFile(path, content);
}

export interface CrateSpec {
  /** 生成的 cargo 工程目录（缓存内，随目标与 profile 隔离）。 */
  readonly directory: string;
  readonly repositoryRoot: string;
  readonly vendorRoot: string;
  /** 已复核的固定版本 Bun checkout：`bun_bin` 的源码在这里。 */
  readonly source: string;
  readonly manifest: NativeManifest;
  readonly manifestPath: string;
  readonly graphRustSource: string;
  readonly workerIdentity: string;
}

/** 生成（或就地更新）应用 crate 的 Cargo.toml / build.rs / src/main.rs。 */
export async function generateCrate(spec: CrateSpec): Promise<void> {
  const bun = parseToml(await readFile(join(spec.source, "Cargo.toml"), "utf8"), "固定版本 Bun 的 Cargo.toml");
  const nativeRoot = join(spec.repositoryRoot, "native");
  const host = parseToml(await readFile(join(nativeRoot, "Cargo.toml"), "utf8"), "native/Cargo.toml");
  const bunProfile = bun.profile;
  if (bunProfile === undefined) fail("固定版本 Bun 的 Cargo.toml 没有 [profile]：原生基线没有可对齐的 cargo 策略");

  // Bun 的 profile 决定 LTO / panic / debuginfo，清单里的 CARGO_PROFILE_* 环境变量会在
  // 其之上继续收紧；宿主自己的 dev 调优（布局与场景构建的 opt-level）单独并进来，否则
  // 内嵌的 debug 构建会把 gpui-pre 编成 O0，帧耗时会比发布版差一个数量级。
  const profile = structuredClone(bunProfile);
  const hostDev = host.profile?.dev;
  const hostPackages = hostDev?.package;
  if (typeof hostPackages === "object" && hostPackages !== null) {
    const dev = { ...profile.dev };
    dev.package = { ...(typeof dev.package === "object" && dev.package !== null ? dev.package : {}), ...hostPackages };
    profile.dev = dev;
  }

  const document = {
    workspace: { resolver: "2" },
    package: {
      name: "r5-server-embedded-app",
      version: stringField(host.package ?? {}, "version", "native/Cargo.toml 的 version"),
      edition: "2024",
      publish: false,
    },
    bin: [{ name: "r5-server", path: "src/main.rs" }],
    dependencies: {
      // 宿主库（feature `embedded` 打开内嵌运行时与 gpui-component）与 bun_bin 的 rlib
      // 必须在同一张 crate 图里：全局分配器、std 与 panic 策略都只能有一份。
      r5_server_gui: {
        package: "r5-server-gui",
        path: join(spec.repositoryRoot, "native"),
        features: ["embedded"],
      },
      bun_rust: {
        package: "bun_bin",
        path: join(spec.source, "src", "bun_bin"),
        features: ["solid-gpui-embed"],
      },
    },
    profile,
    patch: mergePatches(
      {
        document: parseToml(
          await readFile(join(spec.vendorRoot, "Cargo.toml"), "utf8"),
          "vendor/solid-gpui 的 Cargo.toml",
        ),
        root: spec.vendorRoot,
      },
      { document: host, root: nativeRoot },
    ),
  };
  const cargoToml = Bun.TOML.stringify(document);
  if (cargoToml === undefined) fail("无法序列化应用 crate 的 Cargo.toml");

  await mkdir(join(spec.directory, "src"), { recursive: true });
  await writeIfChanged(join(spec.directory, "Cargo.toml"), cargoToml);
  await writeIfChanged(join(spec.directory, "build.rs"), renderBuildScript(spec.manifestPath, spec.manifest));
  await writeIfChanged(join(spec.directory, "src", "main.rs"), renderMain(spec.graphRustSource, spec.workerIdentity));
}

/**
 * 合并两份 `[patch.crates-io]`：宿主 crate 与 vendor/solid-gpui 各自的替换都必须出现在
 * **应用 crate 这个新的 workspace 根**上，否则会静默地去 crates.io 取没打补丁的 gpui-pre
 * 平台实现（多一条、少一条都不报错，只是行为与 pin 住的不一致）。两边的相对路径各按
 * 自己的清单目录解析，宿主那份写的是 `../vendor/...`，不能按 vendor 根解。
 */
function mergePatches(
  ...sources: readonly { readonly document: TomlDocument; readonly root: string }[]
): Record<string, unknown> {
  const patches: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const source of sources) {
    for (const [registry, entries] of Object.entries(source.document.patch ?? {})) {
      const target = (patches[registry] ??= {});
      for (const [name, entry] of Object.entries(entries)) {
        const path = entry.path;
        target[name] = typeof path === "string" ? { ...entry, path: resolve(source.root, path) } : entry;
      }
    }
  }
  return patches;
}

function renderBuildScript(manifestPath: string, manifest: NativeManifest): string {
  const lines = [
    "// 由 scripts/build.ts 生成：把原生图的链接输入原样交给 rustc。",
    "fn main() {",
    `    println!("cargo:rerun-if-changed={}", ${JSON.stringify(manifestPath)});`,
  ];
  for (const argument of [...manifest.objects, ...manifest.archives, ...manifest.linkArgs]) {
    lines.push(`    println!("cargo:rustc-link-arg={}", ${JSON.stringify(argument)});`);
  }
  for (const path of [...manifest.objects, ...manifest.archives]) {
    lines.push(`    println!("cargo:rerun-if-changed={}", ${JSON.stringify(path)});`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

function renderMain(graphRustSource: string, workerIdentity: string): string {
  return [
    '#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]',
    "",
    "// 内嵌运行时的 rlib 提前进图：图里的 C++/Rust 符号与 BUN_COMPILED section 都靠它，",
    "// 宿主库只提供窗口与进程策略。全局分配器由 bun_bin 提供，这里不再声明。",
    "extern crate bun_rust;",
    "",
    `include!(${JSON.stringify(graphRustSource)});`,
    "",
    "fn main() {",
    `    r5_server_gui::run_packaged(BUN_EMBEDDED_ENTRY, ${JSON.stringify(workerIdentity)});`,
    "}",
    "",
  ].join("\n");
}

export interface BuildRequest {
  readonly directory: string;
  readonly manifest: NativeManifest;
  readonly manifestPath: string;
  readonly pin: BunPin;
}

/** 用清单声明的工具链、rustflags 与链接环境编译应用 crate，返回可执行文件路径。 */
export async function buildCrate(request: BuildRequest): Promise<string> {
  const environment: Record<string, string> = {
    ...request.manifest.environment,
    RUSTUP_TOOLCHAIN: request.pin.toolchain,
    CARGO_ENCODED_RUSTFLAGS: request.manifest.rustFlags.join("\u001f"),
    SOLID_GPUI_BUN_LINK_MANIFEST: request.manifestPath,
  };
  const cargo = ["rustup", "run", request.pin.toolchain, "cargo"];
  const options = { cwd: request.directory, env: environment, pinnedToolchain: true } as const;

  // 先正常解析一次：锁缺失时生成，仓库里的依赖清单改过时更新，正常时原样保留。
  // 紧接着用 --locked 编译，保证编译用的就是刚解析出来的那一份锁；解析失败就在这里
  // 失败（真实错误原样冒泡），不做「删锁重来」这类会掩盖问题的兜底。
  await run([...cargo, "metadata", "--format-version", "1"], { ...options, stdout: "ignore" });
  await run(
    [
      ...cargo,
      "build",
      "--locked",
      "--target",
      request.manifest.target,
      "--profile",
      request.manifest.cargoProfile,
      ...request.manifest.cargoArgs,
    ],
    options,
  );

  const executable = applicationExecutable(request.directory, request.manifest.target, request.manifest.cargoProfile);
  if (!(await pathExists(executable))) fail(`cargo 没有产出 ${executable}`);
  return executable;
}

/** cargo 在指定 target 与 profile 下的产物路径（见 [[bin]] 的 name）。 */
function applicationExecutable(directory: string, triple: string, cargoProfile: string): string {
  const profileDirectory = cargoProfile === "dev" ? "debug" : cargoProfile;
  return join(directory, "target", triple, profileDirectory, `r5-server${executableSuffix(triple)}`);
}
