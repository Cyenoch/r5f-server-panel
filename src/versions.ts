/**
 * Version discovery: every subdirectory of the root that carries a dedicated
 * server triad (r5apex_ds.exe + server.dll + loader.dll) is a candidate build.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readTextIfPresent } from "./util";

/** 这三件齐全才算一个可用的版本目录（实例工作副本也按它核对）。 */
export const REQUIRED_FILES = ["r5apex_ds.exe", "server.dll", "loader.dll"] as const;

export type VersionInfo = {
  /** directory name, e.g. "r5f-dedi-1.0.13" */
  name: string;
  /** absolute path */
  path: string;
  /** parsed numeric version, null when the name carries none */
  version: [number, number, number] | null;
  /** triad complete */
  valid: boolean;
  missing: string[];
  /** bytes on disk */
  sizeBytes: number;
  files: number;
  /** build.txt / gameversion.txt contents, when present */
  build: string;
  gameVersion: string;
};

export function parseVersion(name: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(name);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Ordering: named versions first (descending), then unversioned names (descending). */
function compareVersions(a: VersionInfo, b: VersionInfo): number {
  if (a.version && b.version) {
    for (let i = 0; i < 3; i++) {
      if (a.version[i] !== b.version[i]) return b.version[i] - a.version[i];
    }
    return a.name.localeCompare(b.name);
  }
  if (a.version) return -1;
  if (b.version) return 1;
  return b.name.localeCompare(a.name);
}

function directorySize(path: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  try {
    const entries = readdirSync(path, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      try {
        const p = join(e.parentPath ?? path, e.name);
        bytes += statSync(p).size;
        files++;
      } catch {
        /* unreadable entry: skip */
      }
    }
  } catch {
    /* unreadable tree: report what we have */
  }
  return { bytes, files };
}

function inspectVersion(dir: string): VersionInfo {
  const path = dir;
  const name = dir.split(/[\\/]/).findLast(Boolean) ?? dir;
  const missing: string[] = [];
  for (const f of REQUIRED_FILES) {
    try {
      statSync(join(path, f));
    } catch {
      missing.push(f);
    }
  }
  const size = directorySize(path);
  return {
    name,
    path,
    version: parseVersion(name),
    valid: missing.length === 0,
    missing,
    sizeBytes: size.bytes,
    files: size.files,
    build: readTextIfPresent(join(path, "build.txt")).trim(),
    gameVersion: readTextIfPresent(join(path, "gameversion.txt")).trim(),
  };
}

/** Candidate builds: subdirectories with a complete triad, best first. */
export function discoverVersions(root: string, opts: { withSizes?: boolean } = {}): VersionInfo[] {
  let dirs: string[] = [];
  try {
    // `instances/` 装的是每个实例的引擎工作副本（4 GB 级别的复制品），不是安装版本：
    // 把它扫进来既慢又会让人在版本列表里看到自己的副本。
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !["backups", "instances", "src", "node_modules"].includes(e.name))
      .map((e) => join(root, e.name));
  } catch {
    return [];
  }
  const found: VersionInfo[] = [];
  for (const dir of dirs) {
    const info = inspectVersion(dir);
    if (!info.valid) continue;
    if (opts.withSizes === false) {
      info.sizeBytes = -1;
      info.files = -1;
    }
    found.push(info);
  }
  return found.toSorted(compareVersions);
}

export function formatSize(bytes: number): string {
  if (bytes < 0) return "-";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export function isNewer(candidate: VersionInfo, current: VersionInfo | null): boolean {
  if (!current) return true;
  if (candidate.version && current.version) {
    for (let i = 0; i < 3; i++) {
      if (candidate.version[i] !== current.version[i]) return candidate.version[i] > current.version[i];
    }
    return false;
  }
  return candidate.name.localeCompare(current.name) > 0;
}

/** Files an operator may have customised; carried over during an upgrade. */
export const OPERATOR_FILES: { path: string; dir?: boolean }[] = [
  { path: "mods", dir: true },
  { path: "platform/playlists_r5_patch.txt" },
  { path: "platform/r5f_map_names.txt" },
  { path: "platform/r5f_wip_maps.txt" },
  { path: "platform/cfg/system/autoexec_server.cfg" },
  { path: "platform/cfg/system/autoexec_server_dev.cfg" },
  { path: "platform/cfg/system/autoexec.cfg" },
  { path: "platform/cfg/game.cfg" },
  { path: "platform/cfg/tools/rcon_server.cfg" },
  { path: "platform/cfg/tools/rcon_server_dev.cfg" },
  { path: "platform/cfg/tools/rcon_client.cfg" },
];
