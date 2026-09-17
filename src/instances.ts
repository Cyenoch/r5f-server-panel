/**
 * 实例级管道：每个实例的引擎工作副本放在哪、怎么建、以及实例怎么解析自己的版本目录。
 *
 * 为什么每个实例要有一份可写的引擎目录：引擎会在它自己的目录里写东西 ——
 * `autoexec_server.cfg` 的行级覆盖、`platform/logs/server/**` 的健康记录、
 * `banlist.json`、以及它自己合并出来的 playlist 文件。两个实例共用一个版本目录，
 * 这些写操作就会互相覆盖（日志分片会串台、cfg 改动会互相吃掉），
 * 「实例级隔离的配置与日志」只有在各自有目录时才成立。
 *
 * 复制策略：优先 reflink / clonefile（macOS APFS 的 `cp -Rc`、Linux 的
 * `cp -a --reflink=auto`），失败退回普通递归复制。**绝不用硬链接** —— 硬链接让
 * 「副本」与原文件共享同一个 inode，改一处等于改两处，而 cfg 正是要隔离的东西。
 * 复制完按三件套核对目标目录，缺文件就删掉副本并如实报错，不留下半个引擎目录。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { INSTANCES_DIR, ROOT, type ServerInstance, type State, defaultSettings } from "./state";
import { isPidAlive } from "./tap";
import { REQUIRED_FILES, type VersionInfo, discoverVersions, parseVersion } from "./versions";
import * as win from "./win";

/** 工作副本的来源记录：版本名 + 源目录 + 建立时刻（换版本时据此重做）。 */
export type WorkspaceMarker = { version: string; source: string; copiedAt: string };

/** 实例 id 会被拼进路径：只收我们发放的那套字符，别的一律拒绝。 */
function assertInstanceId(id: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error(`实例 id 不合法：${JSON.stringify(id)}`);
  return id;
}

/** `instances/<id>/engine`：这个实例自己的可写引擎目录。 */
export function workspaceDir(id: string): string {
  return join(INSTANCES_DIR, assertInstanceId(id), "engine");
}

export function workspaceMarkerPath(id: string): string {
  return join(INSTANCES_DIR, assertInstanceId(id), "workspace.json");
}

export function readWorkspaceMarker(id: string): WorkspaceMarker | null {
  const path = workspaceMarkerPath(id);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const version = typeof raw.version === "string" ? raw.version : "";
    if (version.length === 0) return null;
    return {
      version,
      source: typeof raw.source === "string" ? raw.source : "",
      copiedAt: typeof raw.copiedAt === "string" ? raw.copiedAt : "",
    };
  } catch {
    return null;
  }
}

/** 三件套齐全才算「这是一份可用的引擎目录」。 */
export function triadMissing(dir: string): string[] {
  return REQUIRED_FILES.filter((name) => !existsSync(join(dir, name)));
}

/**
 * 复制一棵引擎目录树（**异步**：一份官方树 4.5 GB，绝不能在原生 UI 的渲染循环里同步跑完，
 * 否则面板在复制期间整个卡死，连"正在复制"都画不出来）。
 *
 * 顺序：reflink / clonefile（同卷上基本零成本）→ `fs.promises.cp` → 最后才退回同步复制
 * （只在运行时没实现异步 cp 时才会走到，宁可慢也不能不复制）。返回 null = 成功。
 */
async function copyEngineTree(src: string, dst: string): Promise<string | null> {
  if (existsSync(dst)) await rm(dst, { recursive: true, force: true });
  mkdirSync(dirname(dst), { recursive: true });
  const reflink: string[] | null =
    process.platform === "darwin"
      ? ["cp", "-Rc", src, dst]
      : process.platform === "linux"
        ? ["cp", "-a", "--reflink=auto", src, dst]
        : null;
  if (reflink !== null) {
    const child = Bun.spawn(reflink, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const code = await child.exited;
    if (code === 0 && triadMissing(dst).length === 0) return null;
    // 失败原因留给下一次尝试：reflink 在非 APFS / 非同卷上本来就会失败。
    await rm(dst, { recursive: true, force: true });
  }
  try {
    await cp(src, dst, { recursive: true, dereference: false, preserveTimestamps: true });
  } catch (err) {
    if (existsSync(dst) && triadMissing(dst).length > 0) await rm(dst, { recursive: true, force: true });
    if (!existsSync(dst)) {
      try {
        cpSync(src, dst, { recursive: true, dereference: false, preserveTimestamps: true });
      } catch (syncErr) {
        await rm(dst, { recursive: true, force: true });
        return syncErr instanceof Error ? syncErr.message : String(syncErr);
      }
    } else {
      return err instanceof Error ? err.message : String(err);
    }
  }
  const missing = triadMissing(dst);
  if (missing.length > 0) {
    await rm(dst, { recursive: true, force: true });
    return `复制完成但目标目录缺少 ${missing.join(", ")}`;
  }
  return null;
}

export type WorkspaceOutcome =
  | {
      ok: true;
      dir: string;
      copied: boolean;
      replacedVersion: string | null;
      /** 从旧工作副本带过来的、与版本无关的运营数据（相对路径） */
      carried: string[];
      /** 旧工作副本删不掉时留下的路径（可以人工看一眼再删） */
      leftover: string | null;
      warnings: string[];
    }
  | { ok: false; error: string; hint?: string };

/**
 * 换版本时**必须带过去**的东西：引擎自己写的封禁名单与运营者写的公告文案。
 * 不带的话，换一次版本就把封禁名单和公告文案丢了。
 *
 * 刻意**不**带 cfg / playlist 文件：那些是发布产物的一部分，新版本自带的才是对的
 * （面板设置会在启动时重新写进 cfg；模板覆盖会在启动时重新写进 playlist）。
 */
const WORKSPACE_CARRY = ["banlist.json", "platform/datatable/chat_announcements.csv"];

function carryWorkspaceData(from: string, to: string): string[] {
  const carried: string[] = [];
  for (const relative of WORKSPACE_CARRY) {
    const src = join(from, relative);
    if (!existsSync(src)) continue;
    try {
      const dest = join(to, relative);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest);
      carried.push(relative);
    } catch {
      /* 带不过去不算致命：目标目录里已经有版本自带的同名文件 */
    }
  }
  return carried;
}

function writeMarker(instance: ServerInstance, version: VersionInfo): string | null {
  try {
    mkdirSync(dirname(workspaceMarkerPath(instance.id)), { recursive: true });
    writeFileSync(
      workspaceMarkerPath(instance.id),
      `${JSON.stringify({ version: version.name, source: version.path, copiedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * 保证实例的工作副本存在且属于**当前**版本。已有副本则复用（重启不重复复制）；
 * 换过版本则重建 —— 但**绝不在新副本就位之前动旧的**：
 *
 *   1. 复制到暂存目录 `engine.next`（旧目录全程可读可跑）；
 *   2. 把与版本无关的运营数据从旧副本带进新副本；
 *   3. 原子换位：旧目录改名为 `engine.previous`，暂存目录顶上来当 `engine`；
 *   4. 换位成功后才删旧的；删不掉就留下路径让人自己看。
 *
 * 任何一步失败都保留旧目录（并把暂存目录清掉），失败不会让人失去一份能跑的引擎目录。
 */
export async function ensureWorkspace(
  instance: ServerInstance,
  version: VersionInfo,
  report: (line: string) => void = () => {},
): Promise<WorkspaceOutcome> {
  const dir = workspaceDir(instance.id);
  const staging = `${dir}.next`;
  const previous = `${dir}.previous`;
  const marker = readWorkspaceMarker(instance.id);

  // 崩在两次 rename 之间：旧目录还在 `.previous` 里，先恢复它。
  if (!existsSync(dir) && existsSync(previous)) {
    try {
      renameSync(previous, dir);
      report(`上次换副本中断，已从 ${previous} 恢复旧工作副本。`);
    } catch (err) {
      return {
        ok: false,
        error: `工作副本目录缺失且上一个副本恢复不了：${err instanceof Error ? err.message : String(err)}`,
        hint: `人工检查 ${previous} 后重试。`,
      };
    }
  }
  if (marker?.version === version.name && triadMissing(dir).length === 0) {
    return { ok: true, dir, copied: false, replacedVersion: null, carried: [], leftover: null, warnings: [] };
  }
  if (version.path === dir) {
    return {
      ok: false,
      error: `工作副本的复制来源不能是它自己（${dir}）：换版本要从只读的安装目录复制。`,
      hint: "这是内部状态不一致：在「服务器实例」页看一下引擎目录，必要时删掉工作副本重试。",
    };
  }

  report(`为实例「${instance.name}」建立引擎工作副本：${version.path} → ${dir}`);
  const error = await copyEngineTree(version.path, staging);
  if (error !== null) {
    return {
      ok: false,
      error: `无法为实例「${instance.name}」建立引擎工作副本：${error}`,
      hint: "每个实例都要有自己的可写引擎目录（配置与日志隔离）；确认磁盘剩余空间足够放下一份版本目录。",
    };
  }
  const carried = existsSync(dir) ? carryWorkspaceData(dir, staging) : [];
  if (existsSync(previous)) await rm(previous, { recursive: true, force: true }).catch(() => {});
  try {
    if (existsSync(dir)) renameSync(dir, previous);
    renameSync(staging, dir);
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    return {
      ok: false,
      error: `新工作副本就位失败：${err instanceof Error ? err.message : String(err)}`,
      hint: `旧副本没被删除（${existsSync(previous) ? previous : dir}），可以照旧启动。`,
    };
  }
  const warnings: string[] = [];
  const markerError = writeMarker(instance, version);
  if (markerError !== null) {
    warnings.push(
      `工作副本已就位，但来源记录（${workspaceMarkerPath(instance.id)}）写不进去：${markerError}；下次启动会再复制一遍。`,
    );
  }
  let leftover: string | null = null;
  if (existsSync(previous)) {
    try {
      await rm(previous, { recursive: true, force: true });
    } catch {
      leftover = previous;
      warnings.push(`旧工作副本没删掉（换版本前的引擎目录）：${previous} —— 确认不需要后人工删除。`);
    }
  }
  return { ok: true, dir, copied: true, replacedVersion: marker?.version ?? null, carried, leftover, warnings };
}

/** 删掉实例的工作副本（异步：4.5 GB 级目录的删除不能挡住渲染循环）。 */
export async function removeWorkspace(id: string): Promise<string[]> {
  const dir = join(INSTANCES_DIR, assertInstanceId(id));
  if (!existsSync(dir)) return [];
  try {
    await rm(dir, { recursive: true, force: true });
    return [];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}

/** 实例自己的可写引擎目录是否与**想要的版本**一致（不一致 = 下次启动会重建）。 */
export function workspaceReady(instance: ServerInstance): boolean {
  if (instance.version === null) return false;
  if (readWorkspaceMarker(instance.id)?.version !== instance.version) return false;
  return triadMissing(workspaceDir(instance.id)).length === 0;
}

/**
 * 读/写这个实例的版本目录时实际落在哪里：
 *   `"workspace"` = 实例自己的可写副本（写进去只影响它自己）
 *   `"installed"` = 公共的已安装版本目录（**只读**：写进去会影响所有用同一版本的实例）
 *   `null` = 连版本都没选
 */
export function instanceWriteTarget(instance: ServerInstance): "workspace" | "installed" | null {
  const info = instanceVersionInfo(instance);
  if (info === null) return null;
  return info.path === workspaceDir(instance.id) ? "workspace" : "installed";
}

/** 版本元数据（名字/版本号/build…）挂到一个具体目录上。 */
function versionAt(installed: VersionInfo | undefined, name: string, path: string): VersionInfo {
  if (installed !== undefined) return { ...installed, path };
  return {
    name,
    path,
    version: parseVersion(name),
    valid: true,
    missing: [],
    sizeBytes: -1,
    files: -1,
    build: "",
    gameVersion: "",
  };
}

/**
 * 实例的版本目录。优先级就是"谁在写这个目录"：
 *  1. 运行记录里的 `engineDir` —— 那个进程真正在跑/在写的地方（版本换过、还没重启时，
 *     健康/清单/公告必须读它，读新版本的安装目录只会显示一个没人跑过的状态）；
 *  2. 自己的工作副本（副本的版本与想要的版本一致时）；
 *  3. 只读的已安装版本目录（还没启动过的实例读到的就是安装产物本身）。
 */
export function instanceVersionInfo(instance: ServerInstance | null): VersionInfo | null {
  if (instance === null) return null;
  const live = instance.runtime?.engineDir ?? "";
  if (live.length > 0 && triadMissing(live).length === 0) {
    const runtimeName = instance.runtime?.version ?? "";
    const name = runtimeName.length > 0 ? runtimeName : (instance.version ?? "");
    const installed = discoverVersions(ROOT, { withSizes: false }).find((v) => v.name === name);
    return versionAt(installed, name, live);
  }
  if (instance.version === null) return null;
  const installed = discoverVersions(ROOT, { withSizes: false }).find((v) => v.name === instance.version);
  if (installed === undefined) return null;
  if (!workspaceReady(instance)) return installed;
  return { ...installed, path: workspaceDir(instance.id) };
}

/** 按 id / 精确名字 / 不区分大小写的名字找实例。 */
export function findInstance(state: State, key: string): ServerInstance | null {
  const wanted = key.trim();
  if (wanted.length === 0) return null;
  return (
    state.instances.find((instance) => instance.id === wanted) ??
    state.instances.find((instance) => instance.name === wanted) ??
    state.instances.find((instance) => instance.name.toLowerCase() === wanted.toLowerCase()) ??
    null
  );
}

export function instanceLabel(instance: ServerInstance): string {
  return `${instance.name}（${instance.version ?? "未选版本"}）`;
}

/**
 * 一个实例实际会占用的 UDP 端口族。
 *
 * 证据（r5apex_ds.exe 的 cvar 表原文）：`hostport`（默认 37015，"Host game server port"）、
 * `s2sPort`（默认 `37015 + 1`，"S2S communication port"）、`clientport`（默认 37005，
 * "Host game client port"）；另外 `startup_dedi_default.cfg` 里写死 `hostport "37015"`
 * 并带 `-multiple`（引擎自己的多实例开关）。引擎把 S2S 端口排在游戏端口的下一位，
 * 所以**两个实例的主端口不能挨着分配**：A 的 S2S 会正好落在 B 的游戏端口上。
 */
export function instancePorts(port: number): { game: number; s2s: number; client: number } {
  return { game: port, s2s: port + 1, client: port + 2 };
}

/** 整组端口（游戏 / S2S / 客户端）：防火墙与「端口是否被占」都按整组算。 */
export function portFamily(port: number): number[] {
  const family = instancePorts(port);
  return [family.game, family.s2s, family.client];
}

/** 端口分配步长：给 S2S / clientport 留出位置，实例之间不会互相撞。 */
const PORT_STRIDE = 10;

/**
 * 给新实例挑一个空闲端口：避开其它实例已配置的端口族，也避开系统上真的被占用的端口。
 * 返回 0 = 找不到（调用方必须如实拒绝，不能随便抓一个）。
 */
export function nextFreePort(state: State, preferred: number = defaultSettings.port): number {
  const taken = new Set<number>();
  for (const instance of state.instances) {
    const family = instancePorts(instance.settings.port);
    taken.add(family.game);
    taken.add(family.s2s);
    taken.add(family.client);
  }
  const start = Math.min(65530, Math.max(1, Math.trunc(preferred)));
  for (let port = start; port <= 65530 && port < start + 500; port += PORT_STRIDE) {
    const family = instancePorts(port);
    const ports = [family.game, family.s2s, family.client];
    if (ports.some((entry) => taken.has(entry))) continue;
    if (ports.some((entry) => win.portInUse(entry))) continue;
    return port;
  }
  return 0;
}

/**
 * 启动互斥锁：同一个实例不允许多个启动流程同时进行。
 *
 * 两个进程同时 `start` 同一个实例时，"先查进程再 spawn"的窗口足够长，两边都会
 * 各起一个引擎（端口只有一个能绑上，另一个变成幽灵进程）。锁文件写持有者 pid：
 * 持有者已经不在就是陈旧锁，直接接管，不会因为上次崩溃而永远锁死。
 */
export type StartLock = { ok: true; release: () => void } | { ok: false; error: string };

export function acquireStartLock(id: string): StartLock {
  const dir = join(INSTANCES_DIR, assertInstanceId(id));
  const path = join(dir, "start.lock");
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `实例目录写不进去：${err instanceof Error ? err.message : String(err)}` };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
      return {
        ok: true,
        release: () => {
          try {
            rmSync(path, { force: true });
          } catch {
            /* 释放失败不该盖掉启动结果：下一次启动会按 pid 存活接管 */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return { ok: false, error: `启动锁写不进去：${err instanceof Error ? err.message : String(err)}` };
      }
      let holder = 0;
      try {
        holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
      } catch {
        holder = 0;
      }
      // 持锁的进程还活着就一律挡住 —— **包括我们自己**。同一个进程里两次启动同一个实例
      // （面板连点两下）也是并发启动，锁不是可重入的。
      if (Number.isFinite(holder) && holder > 0 && isPidAlive(holder)) {
        return {
          ok: false,
          error: `实例 ${id} 正在启动中（pid ${holder} 的启动流程还没结束）。`,
        };
      }
      rmSync(path, { force: true });
    }
  }
  return { ok: false, error: `实例 ${id} 的启动锁拿不到（有别的进程在抢，稍后再试）。` };
}

/** 已安装版本的元数据 + 只读路径。工作副本的复制来源必须是它，绝不能是工作副本自己。 */
export function releaseVersion(versionName: string | null): VersionInfo | null {
  if (versionName === null) return null;
  return discoverVersions(ROOT, { withSizes: false }).find((version) => version.name === versionName) ?? null;
}
