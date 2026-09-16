import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEV_MODE } from "./dev";
import type { ModeTemplate } from "./mode-templates";
import { ROOT, STATE_FILE, type ServerInstance, type Settings, defaultSettings, loadState, withState } from "./state";

/** 与真机同形：键不带引号、值照原样（`name "FS 1v1"` / `flowstateRoundtime 60`）。 */
const PLAYLISTS = `playlists
{
  Playlists
  {
    fs_1v1
    {
      vars
      {
        name "1v1（模拟）"
        r5f_mode_family 1v1
        r5f_mode_family_title "单挑"
        r5f_mode_title "1v1 练习（模拟）"
        r5f_mode_map mp_rr_arena_habitat
        r5f_mode_order 1
        r5f_mode_blurb "本地开发数据，不运行真实对局"
        flowstateRoundtime 60
        flowstateRoundsBeforeChangeLevel 2
        flowstateAutoChangeLevelEnable 1
      }
      gamemodes { survival { maps { mp_rr_arena_habitat 1
                                   mp_rr_arena_phase_runner 1 } } }
    }
    fs_dm
    {
      vars
      {
        name "Deathmatch（模拟）"
        r5f_mode_family flowstate
        r5f_mode_family_title "Flowstate"
        r5f_mode_title "死斗（模拟）"
        r5f_mode_map mp_rr_arena_phase_runner
        r5f_mode_order 2
      }
      gamemodes { survival { maps { mp_rr_arena_phase_runner 1 } } }
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

/** 沙箱里第一个实例的 id：固定值，方便人直接去看 `.dev/r5f/instances/<id>/engine`。 */
const DEV_INSTANCE_ID = "inst-dev00000000";

/** 沙箱里预置一个模式模板：面板的模式模板页与 `template apply` 一开箱就有东西可试。 */
const DEV_TEMPLATE: ModeTemplate = {
  id: "tpl-dev1v1",
  name: "1v1 · 长局（模拟）",
  playlist: "fs_1v1",
  map: "mp_rr_arena_habitat",
  overrides: { flowstateRoundtime: "600" },
  updatedAt: "2026-01-01T00:00:00.000Z",
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
    const settings: Settings = { ...defaultSettings, hostname: "R5F 开发服（模拟）", statsUpload: "off" };
    const instance: ServerInstance = {
      id: DEV_INSTANCE_ID,
      name: "开发模拟",
      version: "r5f-dedi-1.0.13-dev",
      settings,
      templateId: null,
      runtime: null,
      updatedAt: new Date().toISOString(),
    };
    withState(loadState(), (disk) => {
      if (existsSync(STATE_FILE)) return;
      disk.instances = [instance];
      disk.templates = [DEV_TEMPLATE];
      disk.selectedInstanceId = instance.id;
    });
  }
}
