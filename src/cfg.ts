/**
 * Read the engine's own cfg files.
 *
 * A `.cfg` is a console script: one command per line, `cvar "value"`, `//`
 * comments, `exec <file>`. Line tokenisation (quotes, escapes) is delegated to
 * the maintained `shell-quote` package — a `//` token starts a comment, which
 * is exactly how the engine treats it.
 *
 * Why bother: `autoexec_server.cfg` runs *after* the launch arguments we pass,
 * so it can override a setting the panel writes. Surfacing that saves the
 * "I changed it in the panel and nothing happened" round trip.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as shellParse } from "shell-quote";
import type { FieldId } from "./settings-fields";
import type { Settings } from "./state";
import { readTextIfPresent } from "./util";

export type CfgEntry = { cvar: string; value: string; file: string; line: number };

export type CfgScan = { entries: CfgEntry[]; files: string[] };

export const EMPTY_CFG_SCAN: CfgScan = { entries: [], files: [] };

/** Files the dedicated server actually executes, in load order. */
export const CFG_FILES = [
  "platform/cfg/system/autoexec_server.cfg",
  "platform/cfg/system/autoexec_server_dev.cfg",
  "platform/cfg/system/autoexec.cfg",
  "platform/cfg/game.cfg",
];

/** Launch setting -> the cvar(s) the engine also understands. */
export const FIELD_CVARS: Partial<Record<FieldId, string[]>> = {
  hostname: ["hostname"],
  hostip: ["hostip"],
  visibility: ["spire_host_visibility"],
  authMode: ["sv_onlineAuthMode"],
  password: ["sv_password"],
  quotaString: ["sv_quota_stringCmdsPerSecond"],
  quotaScript: ["sv_quota_scriptExecsPerSecond"],
};

export function parseCfg(text: string, file = ""): CfgEntry[] {
  const entries: CfgEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const tokens = shellParse(lines[index]).filter((token): token is string => typeof token === "string");
    const comment = tokens.findIndex((token) => token.startsWith("//"));
    const command = comment >= 0 ? tokens.slice(0, comment) : tokens;
    const [cvar, ...rest] = command;
    if (!cvar || rest.length === 0) continue;
    if (cvar.startsWith("#") || cvar.startsWith("+") || cvar === "exec") continue;
    entries.push({ cvar, value: rest.join(" "), file, line: index + 1 });
  }
  return entries;
}

export function readCfgScan(versionPath: string | null): CfgScan {
  if (!versionPath) return EMPTY_CFG_SCAN;
  const entries: CfgEntry[] = [];
  const files: string[] = [];
  for (const relative of CFG_FILES) {
    const text = readTextIfPresent(join(versionPath, relative));
    if (text.length === 0) continue;
    files.push(relative);
    entries.push(...parseCfg(text, relative));
  }
  return { entries, files };
}

/**
 * Files the panel keeps in sync. Only files that the dedicated server actually
 * executes are listed, and only cvars already present in them are rewritten —
 * the panel never injects new commands into someone's cfg.
 */
export const CFG_SYNC_FILES = [
  "platform/cfg/system/autoexec_server.cfg",
  "platform/cfg/system/autoexec_server_dev.cfg",
];

export type CfgSync = { file: string; cvar: string; from: string; to: string; line: number };

/**
 * Rewrite one cvar's value, keeping indentation, alignment and the trailing
 * comment untouched. Returns the original text when the cvar is absent.
 */
export function setCvarInText(
  text: string,
  cvar: string,
  value: string,
): { text: string; changed: boolean; before?: string } {
  const pattern = new RegExp(
    `^(\\s*${cvar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})([ \\t]+)("[^"]*"|'[^']*'|\\S+)(.*)$`,
  );
  const quoted = `"${value.replace(/"/g, '\\"')}"`;
  let changed = false;
  let before: string | undefined;
  const lines = text.split(/(?<=\n)/);
  const next = lines.map((line) => {
    const withoutBreak = line.replace(/\r?\n$/, "");
    const br = line.slice(withoutBreak.length);
    const match = pattern.exec(withoutBreak);
    if (!match) return line;
    const current = match[3];
    const bare = current.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
    if (bare === value) return line;
    if (before === undefined) before = current;
    changed = true;
    return `${match[1]}${match[2]}${quoted}${match[4]}${br}`;
  });
  return { text: next.join(""), changed, before };
}

/**
 * Make the panel's values the effective ones.
 *
 * `autoexec_server.cfg` runs *after* the launch arguments, so a value left in
 * it silently wins. Rewriting those lines before spawning keeps the panel and
 * the engine telling the same story.
 */
export function syncLaunchSettings(versionPath: string, settings: Settings): CfgSync[] {
  const changes: CfgSync[] = [];
  for (const relative of CFG_SYNC_FILES) {
    const path = join(versionPath, relative);
    const text = readTextIfPresent(path);
    if (text.length === 0) continue;
    // Line numbers come from the untouched file: rewriting a value never moves
    // a line, so one parse per file is enough.
    const entries = parseCfg(text, relative);
    let updated = text;
    for (const [id, cvars] of Object.entries(FIELD_CVARS) as [FieldId, string[]][]) {
      const wanted = String(settings[id]);
      for (const cvar of cvars) {
        const line = entries.find((entry) => entry.cvar === cvar)?.line;
        if (line === undefined) continue;
        const result = setCvarInText(updated, cvar, wanted);
        if (!result.changed) continue;
        updated = result.text;
        changes.push({ file: relative, cvar, from: result.before ?? "", to: wanted, line });
      }
    }
    if (updated !== text) writeFileSync(path, updated, "utf8");
  }
  return changes;
}

/** Every cfg line that also sets a cvar belonging to this launch setting. */
export function cfgOverridesFor(scan: CfgScan, id: FieldId): CfgEntry[] {
  const cvars = FIELD_CVARS[id];
  if (!cvars || cvars.length === 0) return [];
  return scan.entries.filter((entry) => cvars.includes(entry.cvar));
}

// ------------------------------------------------------- playlist（模式模板）

/** 引擎启动时加载的 playlist 文件（`startup_dedi_*.cfg` 里的 `-playlistfile`）。 */
export const PLAYLIST_FILE = "platform/playlists_r5_patch.txt";

export type PlaylistOverride = { key: string; from: string; to: string };

export type PlaylistOverrideResult = {
  /** 真的改掉的键（值本来就是这个数的会出现在这里，但 `changed` 会是 false） */
  entries: PlaylistOverride[];
  /** 这个玩法块里**没有**同名行的键：启动阶段无法生效（不注入新行） */
  missing: string[];
  /** 文件或玩法块层面的问题（读不到文件、找不到玩法、括号不闭合） */
  error: string | null;
};

const PLAYLIST_VAR = /^(\s*)([A-Za-z0-9_]+)([ \t]+)("[^"]*"|'[^']*'|\S+)([ \t]*(?:\/\/.*)?)$/;

/**
 * 玩法块的起止行号（`{` 与它配对的 `}`）。找不到就返回 null。
 *
 * 只按大括号配对判断：playlist 文件是 keyvalue 文本，一个玩法块里还会嵌
 * `vars { … }`、`gamemodes { … }`，按缩进猜边界会在这些嵌套上出错。
 */
function playlistBlockRange(lines: string[], playlistId: string): { start: number; end: number } | null {
  const open = lines.findIndex((line) => {
    const text = line.trim();
    const bare = text.replace(/^"(.*)"$/, "$1");
    return bare === playlistId;
  });
  if (open < 0) return null;
  // 块开始的大括号可能和玩法名同行（`fs_1v1 {`），也可能在下一行。
  let depth = 0;
  let started = false;
  for (let index = open; index < lines.length; index += 1) {
    for (const ch of lines[index]) {
      if (ch === "{") {
        depth += 1;
        started = true;
      } else if (ch === "}") {
        depth -= 1;
        if (started && depth === 0) return { start: open, end: index };
      }
    }
    // 玩法名之后还没见到 `{` 就遇到同级内容：这不是一个块。
    if (!started && index > open && lines[index].trim().length > 0) return null;
  }
  return null;
}

/**
 * 玩法块里这些键在**发布基线**里的值（从只读安装目录读）。
 *
 * 用途：每个实例的 playlist 文件是私有的，上一版模板写进去的值会留在里面。要让
 * "模板里删掉的覆盖项"真的回到发布默认值，就必须知道发布默认值长什么样 —— 这就是它。
 */
export function playlistBaseline(releasePath: string, playlistId: string, keys: string[]): Record<string, string> {
  const baseline: Record<string, string> = {};
  if (keys.length === 0) return baseline;
  const text = readTextIfPresent(join(releasePath, PLAYLIST_FILE));
  if (text.length === 0) return baseline;
  const lines = text.split(/(?<=\n)/);
  const range = playlistBlockRange(lines, playlistId);
  if (range === null) return baseline;
  for (let index = range.start + 1; index < range.end; index += 1) {
    const withoutBreak = lines[index].replace(/\r?\n$/, "");
    const match = PLAYLIST_VAR.exec(withoutBreak);
    if (match === null || !keys.includes(match[2])) continue;
    baseline[match[2]] = match[4].replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
  }
  return baseline;
}

/**
 * 把模板的覆盖值写进**实例自己那份** playlist 文件里已经存在的同名行。
 *
 * 为什么不是启动参数：脚本读的是 playlist 变量（实测
 * `GetCurrentPlaylistVarFloat("flowstateRoundtime", 600.0)`，`sh_fs_1v1_bridge.gnut`），
 * 变量声明在 playlist 文件的玩法块里；`+<cvar>` 启动参数压的是 cvar，压不到它。
 * 引擎自己的运行期覆盖（`playlist_override_set`）优先级更高，但只活在进程里 ——
 * 所以启动值走文件（每个实例一份私有副本），运行期值走控制通道。
 *
 * 只重写已存在的行（与 cfg 同步同一套约定）：文件里没有这个键就不写、只报告，
 * 绝不往别人的 playlist 里注入新命令。调用方给的 `overrides` 就是**最终想要的整张表**
 * （模板设了值用模板值，模板没设的键用发布基线值），所以"模板里删掉的覆盖项"也会被
 * 改回发布默认值。
 */
export function applyPlaylistOverrides(
  playlistPath: string,
  playlistId: string,
  overrides: Record<string, string>,
): PlaylistOverrideResult {
  const keys = Object.keys(overrides);
  if (keys.length === 0) return { entries: [], missing: [], error: null };
  const text = readTextIfPresent(playlistPath);
  if (text.length === 0) return { entries: [], missing: keys, error: `读不到 ${playlistPath}` };
  const lines = text.split(/(?<=\n)/);
  const range = playlistBlockRange(lines, playlistId);
  if (range === null) return { entries: [], missing: keys, error: `playlist 文件里找不到玩法块 ${playlistId}` };

  const entries: PlaylistOverride[] = [];
  const missing: string[] = [];
  let changed = false;
  for (const key of keys) {
    const wanted = overrides[key];
    let found = false;
    for (let index = range.start + 1; index < range.end; index += 1) {
      const withoutBreak = lines[index].replace(/\r?\n$/, "");
      const br = lines[index].slice(withoutBreak.length);
      const match = PLAYLIST_VAR.exec(withoutBreak);
      if (match === null || match[2] !== key) continue;
      found = true;
      const current = match[4];
      const bare = current.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
      if (bare === wanted) break;
      const quoted = current.startsWith('"') ? `"${wanted}"` : current.startsWith("'") ? `'${wanted}'` : wanted;
      entries.push({ key, from: bare, to: wanted });
      lines[index] = `${match[1]}${match[2]}${match[3]}${quoted}${match[5]}${br}`;
      changed = true;
      break;
    }
    if (!found) missing.push(key);
  }
  if (changed) writeFileSync(playlistPath, lines.join(""), "utf8");
  return { entries, missing, error: null };
}
