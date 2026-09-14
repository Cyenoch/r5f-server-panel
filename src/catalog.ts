import { readFile } from "node:fs/promises";
/**
 * Game catalogs read from the active version directory.
 *
 * Each file has its own format, so each is parsed by a maintained npm package
 * instead of a bespoke scanner:
 *
 *   platform/r5f_map_names.txt      `<stem> = <显示名>` + `#` 注释  → dotenv
 *   platform/playlists_r5_patch.txt Valve KeyValues（Source 2 变体）→ keyvalues-tools
 *
 * The mode catalog is the R5F slice of that same KeyValues tree: only
 * playlists carrying `r5f_mode_family` metadata are gameplay modes the panel
 * may offer. Engine-internal BR playlists (no metadata) stay out.
 *
 * Reading the real lists (instead of hardcoding) keeps the settings page
 * honest: what it offers is exactly what this build accepts.
 */
import { join } from "node:path";
import * as dotenv from "dotenv";
import { parse as parseKeyValues } from "keyvalues-tools";
import { asRecord, readTextIfPresent } from "./util";

export type MapEntry = { stem: string; label: string };

/** One selectable R5F mode = one playlist with `r5f_mode_*` metadata. */
export type ModeEntry = {
  /** playlist key, e.g. `fs_1v1` */
  id: string;
  /** `r5f_mode_title`, else `name`, else the key */
  title: string;
  /** `r5f_mode_family` — the grouping key, e.g. `1v1` */
  family: string;
  /** `r5f_mode_family_title`, else the family key */
  familyTitle: string;
  /** `r5f_mode_family_order`（缺省回落到 `order`） */
  familyOrder: number;
  /** `r5f_mode_order` */
  order: number;
  /** `r5f_mode_map`，未声明时回落到地图清单第一张；都没有则为 "" */
  map: string;
  /** 该 playlist 所有 gamemode 的 `maps` 合并去重（保持文件顺序） */
  maps: string[];
  /** `r5f_mode_blurb` */
  blurb: string;
};

export type ModeFamily = { key: string; title: string; order: number; modes: ModeEntry[] };

export type Catalog = {
  maps: MapEntry[];
  playlists: string[];
  /** 模式目录，按家族分组（`1v1` 等） */
  modes: ModeFamily[];
};

export const EMPTY_CATALOG: Catalog = { maps: [], playlists: [], modes: [] };

const PLAYLISTS_RELATIVE = "platform/playlists_r5_patch.txt";

/** 文件头类型行之外的一切都必须是字符串；KeyValues 把裸值也交给解析器。 */
function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown, fallback: number): number {
  const raw = asText(value);
  if (raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * `<id> -> entry` inside the `Playlists { ... }` block. Parsing the tree (not
 * scanning text) is what makes the bare-value Source 2 dialect a non-issue.
 */
function playlistEntries(text: string): Record<string, unknown> {
  let tree: unknown;
  try {
    tree = parseKeyValues(text);
  } catch {
    return {};
  }
  return asRecord(asRecord(asRecord(tree).playlists).Playlists);
}

/**
 * `<stem> = <显示名>`, `#` comments. dotenv reads exactly this shape
 * (KEY=value, comment lines, trimmed values) and is actively maintained.
 */
export function parseMapNames(text: string): MapEntry[] {
  const parsed = dotenv.parse(text);
  return Object.entries(parsed).map(([stem, label]) => ({ stem, label: label.trim() }));
}

/**
 * Playlist ids are the keys inside the `Playlists { ... }` block of the
 * KeyValues file.
 */
export function parsePlaylistIds(text: string): string[] {
  return Object.keys(playlistEntries(text));
}

/** 一个 playlist 声明的全部地图：每个 gamemode 一张清单，合并去重。 */
function mapsOf(entry: Record<string, unknown>): string[] {
  const gamemodes = asRecord(entry.gamemodes);
  const seen = new Set<string>();
  const maps: string[] = [];
  for (const gamemode of Object.values(gamemodes)) {
    for (const map of Object.keys(asRecord(asRecord(gamemode).maps))) {
      if (seen.has(map)) continue;
      seen.add(map);
      maps.push(map);
    }
  }
  return maps;
}

/** 带 `r5f_mode_family` 的 playlist 才是模式；其余（引擎内部 BR 玩法）不进目录。 */
export function parseModes(text: string): ModeEntry[] {
  const modes: ModeEntry[] = [];
  for (const [id, value] of Object.entries(playlistEntries(text))) {
    const entry = asRecord(value);
    const vars = asRecord(entry.vars);
    const family = asText(vars.r5f_mode_family);
    if (family === "") continue;
    const order = asNumber(vars.r5f_mode_order, 0);
    const maps = mapsOf(entry);
    modes.push({
      id,
      title: asText(vars.r5f_mode_title) || asText(vars.name) || id,
      family,
      familyTitle: asText(vars.r5f_mode_family_title) || family,
      familyOrder: asNumber(vars.r5f_mode_family_order, order),
      order,
      map: asText(vars.r5f_mode_map) || maps[0] || "",
      maps,
      blurb: asText(vars.r5f_mode_blurb),
    });
  }
  return modes;
}

/** 按 `familyOrder` 升序分家族，家族内按 `order`（同序时按 id）稳定排列。 */
export function groupByFamily(modes: ModeEntry[]): ModeFamily[] {
  const families = new Map<string, ModeFamily>();
  for (const mode of modes) {
    const existing = families.get(mode.family);
    if (existing) {
      existing.modes.push(mode);
      existing.order = Math.min(existing.order, mode.familyOrder);
      continue;
    }
    families.set(mode.family, {
      key: mode.family,
      title: mode.familyTitle,
      order: mode.familyOrder,
      modes: [mode],
    });
  }
  const grouped = [...families.values()];
  for (const family of grouped) {
    family.modes.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }
  grouped.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  return grouped;
}

/** 已知模式的地图清单；未收录时为空数组。 */
export function mapsForPlaylist(modes: ModeEntry[], playlistId: string): string[] {
  const mode = modes.find((entry) => entry.id === playlistId);
  if (!mode) return [];
  if (mode.maps.length > 0) return mode.maps;
  return mode.map === "" ? [] : [mode.map];
}

export function loadCatalog(versionPath: string | null): Catalog {
  if (!versionPath) return EMPTY_CATALOG;
  const maps = parseMapNames(readTextIfPresent(join(versionPath, "platform", "r5f_map_names.txt")));
  const playlistText = readTextIfPresent(join(versionPath, PLAYLISTS_RELATIVE));
  const playlists = parsePlaylistIds(playlistText);
  const modes = groupByFamily(parseModes(playlistText));
  if (maps.length === 0 && playlists.length === 0 && modes.length === 0) return EMPTY_CATALOG;
  return { maps, playlists, modes };
}

/** 模式目录读盘入口；文件缺失时返回空目录而不是抛错。 */
export async function collectModes(versionDir: string): Promise<ModeFamily[]> {
  let text = "";
  try {
    text = await readFile(join(versionDir, PLAYLISTS_RELATIVE), "utf8");
  } catch {
    return [];
  }
  return groupByFamily(parseModes(text));
}
