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
