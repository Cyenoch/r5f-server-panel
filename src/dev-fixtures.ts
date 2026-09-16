import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEV_MODE } from "./dev";
import { ROOT, STATE_FILE, defaultSettings, saveState } from "./state";

const PLAYLISTS = `"playlists"
{
  "Playlists"
  {
    "fs_1v1"
    {
      "vars"
      {
        "name" "1v1"
        "r5f_mode_family" "1v1"
        "r5f_mode_family_title" "单挑"
        "r5f_mode_title" "1v1 练习（模拟）"
        "r5f_mode_map" "mp_rr_arena_habitat"
        "r5f_mode_order" "1"
        "r5f_mode_blurb" "本地开发数据，不运行真实对局"
      }
      "gamemodes" { "survival" { "maps" { "mp_rr_arena_habitat" "1" "mp_rr_arena_phase_runner" "1" } } }
    }
    "fs_dm"
    {
      "vars"
      {
        "name" "Deathmatch"
        "r5f_mode_family" "flowstate"
        "r5f_mode_family_title" "Flowstate"
        "r5f_mode_title" "死斗（模拟）"
        "r5f_mode_map" "mp_rr_arena_phase_runner"
        "r5f_mode_order" "2"
      }
      "gamemodes" { "survival" { "maps" { "mp_rr_arena_phase_runner" "1" } } }
    }
  }
}
`;

const FILES: Record<string, string> = {
  "r5apex_ds.exe": "SIMULATED R5F fixture, not executable.\n",
  "server.dll": "SIMULATED R5F fixture, not a library.\n",
  "loader.dll": "SIMULATED R5F fixture, not a library.\n",
  "build.txt": "local development fixture (not an engine build)\n",
  "gameversion.txt": "SIMULATED\n",
  "platform/r5f_map_names.txt": "mp_rr_arena_habitat=Habitat\nmp_rr_arena_phase_runner=Phase Runner\n",
  "platform/playlists_r5_patch.txt": PLAYLISTS,
  "platform/cfg/system/autoexec_server.cfg": [
    "// Local simulator configuration; never loaded by a real engine.",
    'hostname "R5F 开发服（模拟）"',
    'spire_host_visibility "0"',
    'sv_onlineAuthMode "0"',
    'sv_password ""',
    'sv_quota_stringCmdsPerSecond "256"',
    'sv_quota_scriptExecsPerSecond "128"',
    "",
  ].join("\n"),
  "platform/datatable/chat_announcements.csv": [
    "# Local simulated announcements; no messages are sent to real players.",
    "kind,tag,text,color,sustain,fade,wait",
    "string,string,string,string,float,float,float",
    "welcome,[DEV],欢迎进入本地模拟服务器,cyan,8,2,10",
    "rotate,[DEV],这些玩家和运行数据均为模拟,gold,8,2,60",
    "",
  ].join("\n"),
  "banlist.json": "[]\n",
};

/** Seed only missing files: edits and selection survive hot reloads and CLI subprocesses. */
export function ensureDevFixtures(): void {
  if (!DEV_MODE) return;
  for (const version of ["r5f-dedi-1.0.13-dev", "r5f-dedi-1.0.14-dev"]) {
    for (const [relative, content] of Object.entries(FILES)) {
      const path = join(ROOT, version, relative);
      if (existsSync(path)) continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { flag: "wx" });
    }
  }
  if (!existsSync(STATE_FILE)) {
    const settings = { ...defaultSettings, hostname: "R5F 开发服（模拟）", statsUpload: "off" as const };
    saveState({
      current: "r5f-dedi-1.0.13-dev",
      settings,
      profiles: [{ name: "开发模拟", settings: { ...settings }, updatedAt: new Date().toISOString() }],
      currentProfile: "开发模拟",
      runtime: null,
      history: [],
    });
  }
}
