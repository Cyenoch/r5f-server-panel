/**
 * 模式模板：一个「玩法 + 地图 + 一组对局参数」的命名预设。
 *
 * 只暴露**引擎脚本真的会读**的 playlist 变量，每个键都能指到读它的那几行：
 *
 *   flowstateRoundtime
 *     fs_1v1     sh_fs_1v1_bridge.gnut:228-230（兜底 600 秒）
 *                → Gamemode1v1_Init 里读一次并缓存（_gamemode_1v1.nut:1216、2137），
 *                  每局用的是缓存值（_gamemode_1v1.nut:3255）→ 换图后才重新读
 *     fs_instagib _gamemode_instagib.nut:144（兜底 800 秒）→ 每局开头重读
 *   flowstateRoundsBeforeChangeLevel
 *     fs_1v1     sh_fs_1v1_helpers.gnut:339-341（兜底 2）
 *     fs_instagib _gamemode_instagib.nut:169（兜底 3）
 *   flowstateAutoChangeLevelEnable
 *     fs_1v1     sh_fs_1v1_helpers.gnut:344-346（兜底 false）
 *     fs_instagib _gamemode_instagib.nut:169（兜底 false）
 *   三条都在每局结束时判定（_gamemode_1v1.nut:807-809 / _gamemode_instagib.nut:169）
 *
 * 玩法自己的值写在 `platform/playlists_r5_patch.txt` 里（本版：fs_1v1 行 4979-4985、
 * fs_lgduels_1v1 行 5174-5180、fs_instagib 行 5337-5340）——不算覆盖时引擎用的就是它。
 * 别的玩法（TDM / Control / FFA / 枪战 / 地图编辑器…）的脚本没有读这些键，所以
 * `templateFields()` 对它们返回空数组：宁可不给旋钮，也不给"看着能调、其实没人读"的假参数。
 *
 * 模板应用走引擎自带的运行时覆盖命令（server.dll 原文：`playlist_override_set <var> <value>`，
 * "Overrides a playlist var for every connected client"）。运行期覆盖只活在进程里；
 * 启动时由 commands.ts 将模板写入实例私有 playlist，共享版本目录保持只读。
 */

/** 一个可调参数（`templateFields()` 的返回值，面板照它渲染编辑器）。 */
export type TemplateField = {
  /** 引擎侧 playlist 变量名，同时是 `playlist_override_set` 的第一个参数 */
  key: string;
  label: string;
  description: string;
  kind: "number" | "boolean";
  /** 玩法自己声明的值（playlist 里没写时用脚本兜底值），十进制字符串 */
  defaultValue: string;
  min?: number;
  max?: number;
  /**
   * 什么时候重新读取这个值：
   *   next-round  每局开始时都会重读 → 下一局就能用上
   *   changelevel 换图（关卡初始化）时才重读 → 要等下一次换图
   */
  effect: "next-round" | "changelevel";
};

/** 一份模式模板。面板只存这几项，运行时状态一概不落盘。 */
export type ModeTemplate = {
  id: string;
  name: string;
  /** 引擎玩法 id（playlist 键，例如 `fs_1v1`）；空串 = 还没选 */
  playlist: string;
  /** 启动地图名；空串 = 由玩法自己的地图清单决定 */
  map: string;
  /** playlist 变量 → 值；缺省的键 = 不覆盖（跟随玩法自己的值） */
  overrides: Record<string, string>;
  updatedAt: string;
};

type FieldKey = "flowstateRoundtime" | "flowstateRoundsBeforeChangeLevel" | "flowstateAutoChangeLevelEnable";

type FieldSpec = Omit<TemplateField, "defaultValue" | "effect"> & { key: FieldKey };

/**
 * 面板侧的取值范围。引擎自己只对上报名做 1–3600 秒的截断
 * （`_1v1_match.nut:1032-1036`），局数上限纯属面板约束 —— 写在 description 里说清楚。
 */
const ROUNDTIME_MIN = 10;
const ROUNDTIME_MAX = 3600;
const ROUNDS_MIN = 1;
const ROUNDS_MAX = 20;

const FIELD_SPECS: FieldSpec[] = [
  {
    key: "flowstateRoundtime",
    label: "单局时长",
    kind: "number",
    min: ROUNDTIME_MIN,
    max: ROUNDTIME_MAX,
    description: `一局最多打多久，单位秒（面板允许 ${ROUNDTIME_MIN}–${ROUNDTIME_MAX}）。引擎侧对上报用的时长还会再截到 1–3600 秒。`,
  },
  {
    key: "flowstateRoundsBeforeChangeLevel",
    label: "换图前局数",
    kind: "number",
    min: ROUNDS_MIN,
    max: ROUNDS_MAX,
    description: `打满这么多局才轮到换图（引擎条件是「当前局数 > 这个值」，所以填 2 = 第 3 局结束才换）。面板允许 ${ROUNDS_MIN}–${ROUNDS_MAX}。`,
  },
  {
    key: "flowstateAutoChangeLevelEnable",
    label: "自动换图",
    kind: "boolean",
    description: "开关：到了上面的局数就自动换下一张地图；关掉则一直停在当前地图。",
  },
];

type Values = Partial<Record<FieldKey, string>>;

/**
 * 脚本家族：一组脚本读同一批变量，所以同一家族里的玩法共用一套字段。
 *
 * `playlists` 的成员来自脚本自己的判断 —— fs_1v1 家族看
 * `sh_fs_1v1_helpers.gnut:126` 的 `FS_Is1v1Playlist()`；instagib 是独立 gamemode
 * （`gamemodes/fs_instagib/sh_fs_instagib_register.gnut`）。
 * `declared` 是玩法在 playlists_r5_patch.txt 里写死的值；没写声明的（本版清单里没有，
 * 但脚本认得的名字）只能退回脚本兜底值。
 */
type ScriptFamily = {
  /** 脚本目录名，用于说明"这套参数归谁读" */
  key: string;
  playlists: Record<string, Values>;
  fallback: Record<FieldKey, string>;
  effect: Record<FieldKey, TemplateField["effect"]>;
};

const FAMILIES: ScriptFamily[] = [
  {
    key: "fs_1v1",
    // playlists_r5_patch.txt：fs_1v1 行 4979-4985、fs_lgduels_1v1 行 5174-5180
    playlists: {
      fs_1v1: {
        flowstateRoundtime: "60",
        flowstateRoundsBeforeChangeLevel: "2",
        flowstateAutoChangeLevelEnable: "1",
      },
      fs_lgduels_1v1: {
        flowstateRoundtime: "60",
        flowstateRoundsBeforeChangeLevel: "2",
        flowstateAutoChangeLevelEnable: "1",
      },
      // 脚本认得、本版 playlist 文件里没有这三条 —— 默认值只能用脚本兜底值。
      fs_vamp_1v1: {},
      fs_1v1_headshots_only: {},
      fs_1v1_coaching: {},
    },
    fallback: {
      flowstateRoundtime: "600",
      flowstateRoundsBeforeChangeLevel: "2",
      flowstateAutoChangeLevelEnable: "0",
    },
    effect: {
      flowstateRoundtime: "changelevel",
      flowstateRoundsBeforeChangeLevel: "next-round",
      flowstateAutoChangeLevelEnable: "next-round",
    },
  },
  {
    key: "fs_instagib",
    // playlists_r5_patch.txt：fs_instagib 行 5337-5340
    playlists: {
      fs_instagib: {
        flowstateRoundtime: "800",
        flowstateRoundsBeforeChangeLevel: "3",
        flowstateAutoChangeLevelEnable: "1",
      },
    },
    fallback: {
      flowstateRoundtime: "800",
      flowstateRoundsBeforeChangeLevel: "3",
      flowstateAutoChangeLevelEnable: "0",
    },
    effect: {
      flowstateRoundtime: "next-round",
      flowstateRoundsBeforeChangeLevel: "next-round",
      flowstateAutoChangeLevelEnable: "next-round",
    },
  },
];

/** 玩法 → 它那套脚本；不是已知玩法就返回 null（= 没有任何可调参数）。 */
function familyOf(playlist: string): { family: ScriptFamily; values: Values } | null {
  for (const family of FAMILIES) {
    const values = family.playlists[playlist];
    if (values) return { family, values };
  }
  return null;
}

/**
 * 这个玩法的可调参数；未知玩法（脚本没读任何 R5F 变量）返回空数组。
 *
 * 面板**只**按这份清单渲染编辑器，所以清单里不会出现"引擎不认"的键。
 */
export function templateFields(playlist: string): TemplateField[] {
  const found = familyOf(playlist);
  if (!found) return [];
  return FIELD_SPECS.map((spec) => ({
    key: spec.key,
    label: spec.label,
    description: spec.description,
    kind: spec.kind,
    min: spec.min,
    max: spec.max,
    defaultValue: found.values[spec.key] ?? found.family.fallback[spec.key],
    effect: found.family.effect[spec.key],
  }));
}

const NAME_MAX = 48;
/** 引擎侧对覆盖值有长度上限（server.dll `[PLO] value must be at most %d characters`），我们的值都是短数字。 */
const VALUE_MAX = 64;
/** playlist id：引擎里都是小写字母、数字、下划线（没有长度下界，上限与地图名同级）。 */
const PLAYLIST_PATTERN = /^[a-z0-9_]{1,63}$/;
/** 地图名按引擎自己的规则（`Tracker_IsSafeMapName`）：3–63 个小写字母、数字、下划线。 */
const MAP_PATTERN = /^[a-z0-9_]{3,63}$/;

/** 手改过的状态文件里可能是数字/布尔，统一成字符串再判断。 */
function asText(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return "";
}

/** 布尔字段接受的写法（`GetCurrentPlaylistVarBool` 认 0/1；true/false 是给手改文件的宽容）。 */
function canonicalBoolean(text: string): string | null {
  if (text === "1" || text === "true") return "1";
  if (text === "0" || text === "false") return "0";
  return null;
}

/** 值 → 能安全拼进命令行的规范形式；不合法就返回 null（绝不原样透传）。 */
function canonicalValue(field: TemplateField, raw: unknown): string | null {
  const text = asText(raw);
  if (text.length === 0 || text.length > VALUE_MAX) return null;
  if (field.kind === "boolean") return canonicalBoolean(text);
  if (!/^\d+$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  if (field.min !== undefined && value < field.min) return null;
  if (field.max !== undefined && value > field.max) return null;
  return String(value);
}

function valueProblem(field: TemplateField, raw: unknown): string | null {
  const text = asText(raw);
  if (text.length === 0) return `${field.label}没有填值（不想覆盖就把这一项去掉）`;
  if (canonicalValue(field, text) !== null) return null;
  if (field.kind === "boolean") return `${field.label}只能填 0（关）或 1（开）`;
  if (!/^\d+$/.test(text)) return `${field.label}只能填整数`;
  return `${field.label}必须介于 ${field.min} 和 ${field.max} 之间`;
}

/**
 * 保存前的校验；返回空数组表示这份模板可以存、也可以下发。
 *
 * 校验包含面板能独立判断的全部内容：名字、玩法 id、地图名（按引擎自己的地图名规则
 * `Tracker_IsSafeMapName`：3–63 个小写字母/数字/下划线）、每个覆盖键是否属于这个玩法、
 * 每个值的类型与范围。玩法**是否存在**只有目录知道，由面板读版本目录时对照（见模板页）。
 */
export function validateTemplate(template: ModeTemplate): string[] {
  const problems: string[] = [];
  if (asText(template.id).length === 0) problems.push("模板缺少 id");
  const name = asText(template.name);
  if (name.length === 0) problems.push("模板名不能为空");
  else if (name.length > NAME_MAX) problems.push(`模板名最长 ${NAME_MAX} 个字符（当前 ${name.length} 个）`);

  const playlist = asText(template.playlist);
  if (playlist.length === 0) problems.push("先选一个玩法");
  else if (!PLAYLIST_PATTERN.test(playlist)) problems.push("玩法 id 只能是小写字母、数字和下划线");

  const map = asText(template.map);
  if (map.length > 0 && !MAP_PATTERN.test(map)) {
    problems.push("地图名只能是 3–63 个小写字母、数字或下划线（引擎自己的地图名规则）");
  }

  const fields = templateFields(playlist);
  for (const [key, raw] of Object.entries(template.overrides ?? {})) {
    const field = fields.find((candidate) => candidate.key === key);
    if (!field) {
      problems.push(`「${playlist || "这个玩法"}」没有 ${key} 这个可调参数`);
      continue;
    }
    const problem = valueProblem(field, raw);
    if (problem !== null) problems.push(problem);
  }
  return problems;
}

/**
 * 模板 → 引擎命令。只有 `playlist_override_set <var> <value>`，没有换图、没有 bridge 调用：
 * 换玩法/换图是调用方的事（要显式做，不能因为"应用了模板"就顺手把玩家踢下线）。
 *
 * 键只从 `templateFields(template.playlist)` 里取（引擎不读的键一个都不发），值经过
 * `canonicalValue` 归一成整数或 0/1 —— 用户输入没有机会变成第二个参数之外的东西。
 * 非法值在这里**不发**（也不偷偷替换成别的值），调用方应当先跑 `validateTemplate()`。
 */
export function templateCommands(template: ModeTemplate): string[] {
  const commands: string[] = [];
  for (const field of templateFields(asText(template.playlist))) {
    const raw = template.overrides?.[field.key];
    if (raw === undefined) continue;
    const value = canonicalValue(field, raw);
    if (value === null) continue;
    commands.push(`playlist_override_set ${field.key} ${value}`);
  }
  return commands;
}
