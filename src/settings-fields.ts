/**
 * One declarative table for every launch setting.
 *
 * Rendering, editing, validation and the CLI all read this table, so a value
 * can never be accepted by one surface and rejected by another.
 *
 * Each field owns three things:
 *   display  what the settings list shows
 *   hint     the long description under the selected row
 *   parse    raw text (what a human typed) -> typed value, or a reason it fails
 */
import type { Catalog } from "./catalog";
import type { Settings } from "./state";

export type FieldId = keyof Settings;

export type FieldKind = "int" | "text" | "password" | "enum" | "catalog";

export type FieldOption = { value: string; label: string; note?: string };

export type FieldContext = { catalog: Catalog; settings: Settings };

/** Maps declared by the selected mode, when that playlist is a known R5F mode. */
function modeMaps(catalog: Catalog, playlist: string): string[] {
  if (playlist.length === 0) return [];
  for (const family of catalog.modes) {
    const mode = family.modes.find((m) => m.id === playlist);
    if (mode) return mode.maps;
  }
  return [];
}

/** Families in display order: the 1v1 family first, then by declared order. */
function orderedFamilies(catalog: Catalog) {
  return catalog.modes.toSorted((a, b) => {
    if (a.key === "1v1") return -1;
    if (b.key === "1v1") return 1;
    return a.order - b.order;
  });
}

export type ParseOk = { ok: true; value: Settings[FieldId] };
export type ParseFail = { ok: false; error: string };
export type ParseResult = ParseOk | ParseFail;

export type FieldDef = {
  id: FieldId;
  label: string;
  kind: FieldKind;
  /** what the value is for, shown when the row is selected */
  hint: string;
  /** accepted input, shown in the editor */
  spec: string;
  /** when a change takes effect */
  scope: string;
  /** 引擎侧名字（cvar/启动参数）：只给 CLI 用，面板不显示 */
  engineName?: string;
  /** the settings list line */
  display: (settings: Settings) => string;
  /** human-readable default, shown in the list and the detail pane */
  defaultText: (settings: Settings) => string;
  /** machine-readable default, used by "恢复默认"; never re-parsed from display text */
  defaultValue: Settings[FieldId];
  /** assign the parsed value; keeps every field type-checked without casts */
  assign: (settings: Settings, value: Settings[FieldId]) => void;
  /** candidates for enum/catalog fields; the first entry may offer free text */
  options?: (ctx: FieldContext) => FieldOption[];
  parse: (raw: string) => ParseResult;
  /** the editor opens with this text */
  editText: (settings: Settings) => string;
  /** long values are worth flagging in the list */
  warn?: (settings: Settings) => string | null;
};

const MAX_HOSTNAME = 60;

function parseIntInRange(raw: string, lo: number, hi: number, what: string): ParseResult {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, error: `${what}不能为空` };
  if (!/^\d+$/.test(text)) return { ok: false, error: `${what}只能是数字` };
  const value = Number.parseInt(text, 10);
  if (value < lo || value > hi) return { ok: false, error: `${what}必须介于 ${lo} 与 ${hi} 之间` };
  return { ok: true, value };
}

const visibilityLabel = (value: number): string => (value === 0 ? "离线" : value === 1 ? "隐藏" : "公开");
const authLabel = (value: number): string =>
  value === 0 ? "关闭" : value === 1 ? "强制校验 join token" : "有 token 就校验";

/** `（手动输入…）` marker: pickers end with it so any value stays reachable. */
export const MANUAL_OPTION = "__manual__";

export const SETTINGS_FIELDS: FieldDef[] = [
  {
    id: "hostname",
    label: "服务器名",
    kind: "text",
    engineName: "+hostname",
    hint: "显示在玩家看到的服务器列表与控制台标题里。",
    spec: `1–${MAX_HOSTNAME} 个字符，允许中文`,
    scope: "重启服务器后生效",
    display: (s) => (s.hostname.trim().length === 0 ? "(空)" : s.hostname),
    defaultText: () => "R5F Server",
    defaultValue: "R5F Server",
    assign: (s, value) => {
      s.hostname = String(value);
    },
    editText: (s) => s.hostname,
    parse: (raw) => {
      const text = raw.trim();
      if (text.length === 0) return { ok: false, error: "服务器名不能为空" };
      if (text.length > MAX_HOSTNAME)
        return { ok: false, error: `服务器名最长 ${MAX_HOSTNAME} 个字符（当前 ${text.length}）` };
      return { ok: true, value: text };
    },
  },
  {
    id: "map",
    label: "地图",
    kind: "catalog",
    engineName: "+map",
    hint: "启动时载入的地图。选了模式后，清单会收敛到该模式带的地图；否则用当前版本允许的地图清单。",
    spec: "从清单选择，或手动输入地图名",
    scope: "重启服务器后生效（换图会重新加载，约 20 秒）",
    display: (s) => s.map || "(启动后由玩家选择)",
    defaultText: () => "mp_rr_arena_habitat",
    defaultValue: "mp_rr_arena_habitat",
    assign: (s, value) => {
      s.map = String(value);
    },
    editText: (s) => s.map,
    options: (ctx) => {
      const declared = modeMaps(ctx.catalog, ctx.settings.playlist);
      if (declared.length > 0) {
        return [
          ...declared.map((stem, index) => ({
            value: stem,
            label: stem,
            note: index === 0 ? `模式 ${ctx.settings.playlist} 的地图清单（${declared.length} 张）` : undefined,
          })),
          { value: MANUAL_OPTION, label: "（手动输入…）" },
        ];
      }
      return [
        { value: "", label: "(空)", note: "不指定地图，启动后由玩家选择" },
        ...ctx.catalog.maps.map((m) => ({ value: m.stem, label: m.stem, note: m.label })),
        { value: MANUAL_OPTION, label: "（手动输入…）" },
      ];
    },
    parse: (raw) => ({ ok: true, value: raw.trim() }),
  },
  {
    id: "playlist",
    label: "模式",
    kind: "catalog",
    engineName: "+launchplaylist",
    hint: "要跑的玩法。清单来自服务端自带的模式目录，按家族分组（1v1 在最前）；留空表示启动后由玩家选择。",
    spec: "从模式清单选择，或手动输入模式 id",
    scope: "重启服务器后生效；运行中可在本页按 x 立即切换",
    display: (s) => (s.playlist.length === 0 ? "(空 = 由玩家选择)" : s.playlist),
    defaultText: () => "fs_1v1",
    defaultValue: "fs_1v1",
    assign: (s, value) => {
      s.playlist = String(value);
    },
    editText: (s) => s.playlist,
    options: (ctx) => {
      const cataloged = new Set(ctx.catalog.modes.flatMap((family) => family.modes.map((mode) => mode.id)));
      return [
        { value: "", label: "(空)", note: "启动后由玩家选择模式" },
        ...orderedFamilies(ctx.catalog).flatMap((family) =>
          family.modes.map((mode) => ({
            value: mode.id,
            label: mode.id,
            note: `${family.title} · ${mode.title}${mode.maps.length > 0 ? ` · ${mode.maps.length} 图` : ""}`,
          })),
        ),
        ...ctx.catalog.playlists
          .filter((id) => !cataloged.has(id))
          .map((id) => ({ value: id, label: id, note: "不在 R5F 模式目录内" })),
        { value: MANUAL_OPTION, label: "（手动输入…）" },
      ];
    },
    parse: (raw) => ({ ok: true, value: raw.trim() }),
  },
  {
    id: "visibility",
    label: "可见性",
    kind: "enum",
    engineName: "spire_host_visibility",
    hint: "离线=只能直连 IP；隐藏=不列出但可加入；公开=出现在服务器列表。",
    spec: "0 / 1 / 2",
    scope: "重启服务器后生效",
    display: (s) => `${s.visibility}  ${visibilityLabel(s.visibility)}`,
    defaultText: () => "0（离线）",
    defaultValue: 0,
    assign: (s, value) => {
      s.visibility = Number(value) as Settings["visibility"];
    },
    editText: (s) => String(s.visibility),
    options: () => [
      { value: "0", label: "0  离线", note: "仅直连，不向列表上报" },
      { value: "1", label: "1  隐藏", note: "有 IP 才能加入" },
      { value: "2", label: "2  公开", note: "出现在服务器浏览器（需要认证配合）" },
      { value: MANUAL_OPTION, label: "（手动输入…）" },
    ],
    parse: (raw) => {
      const parsed = parseIntInRange(raw, 0, 2, "可见性");
      return parsed;
    },
  },
  {
    id: "authMode",
    label: "在线认证",
    kind: "enum",
    engineName: "sv_onlineAuthMode",
    hint: "官方在线认证强度，公开服建议开启。",
    spec: "0 / 1 / 2",
    scope: "重启服务器后生效",
    display: (s) => `${s.authMode}  ${authLabel(s.authMode)}`,
    defaultText: () => "0（关闭）",
    defaultValue: 0,
    assign: (s, value) => {
      s.authMode = Number(value) as Settings["authMode"];
    },
    editText: (s) => String(s.authMode),
    options: () => [
      { value: "0", label: "0  关闭", note: "任何人可进" },
      { value: "1", label: "1  强制 join token", note: "更严格，部分客户端会进不来" },
      { value: "2", label: "2  有就校验", note: "折中" },
      { value: MANUAL_OPTION, label: "（手动输入…）" },
    ],
    parse: (raw) => parseIntInRange(raw, 0, 2, "认证模式"),
  },
  {
    id: "statsUpload",
    label: "1v1 数据上报",
    kind: "enum",
    engineName: "fs_stats_url",
    hint: "1v1 对战统计默认会上报给 R5F 的统计服务；选“关闭”后本机不再外发任何对战数据。",
    spec: "保持默认 / 关闭",
    scope: "重启服务器后生效",
    display: (s) => (s.statsUpload === "off" ? "关闭（不外发）" : "上报（默认，发往 R5F 统计服务）"),
    defaultText: () => "上报（默认）",
    defaultValue: "default",
    assign: (s, value) => {
      s.statsUpload = value === "off" ? "off" : "default";
    },
    editText: (s) => s.statsUpload,
    options: () => [
      {
        value: "default",
        label: "保持默认（上报）",
        note: "对战统计发往 R5F 统计服务",
      },
      {
        value: "off",
        label: "关闭上报",
        note: "本机不再外发任何对战数据",
      },
      { value: MANUAL_OPTION, label: "（手动输入…）" },
    ],
    parse: (raw) => {
      const text = raw.trim();
      if (text === "default" || text === "off") return { ok: true, value: text };
      return { ok: false, error: "只能是 default 或 off" };
    },
  },
  {
    id: "announceRotate",
    label: "公告轮播",
    kind: "enum",
    engineName: "bridge_chat_announce",
    hint: "开启后引擎会把公告文案轮播给在线玩家，并在玩家进入时发欢迎语；关闭（引擎默认）则一条都不发。运行中可在公告页按 t 立即开关。",
    spec: "开启 / 关闭（引擎默认）",
    scope: "重启服务器后生效；运行中可在公告页立即开关",
    display: (s) => (s.announceRotate === "on" ? "开启（轮播 + 进场欢迎）" : "关闭（引擎默认，不发公告）"),
    defaultText: () => "关闭（引擎默认）",
    defaultValue: "default",
    assign: (s, value) => {
      s.announceRotate = value === "on" ? "on" : "default";
    },
    editText: (s) => s.announceRotate,
    options: () => [
      { value: "default", label: "关闭（引擎默认）", note: "引擎不广播任何公告" },
      { value: "on", label: "开启", note: "按文案表轮播，并给进入的玩家发欢迎语" },
      { value: MANUAL_OPTION, label: "（手动输入…）" },
    ],
    parse: (raw) => {
      const text = raw.trim();
      if (text === "default" || text === "on") return { ok: true, value: text };
      return { ok: false, error: "只能是 default 或 on" };
    },
  },
  {
    id: "port",
    label: "端口（UDP）",
    kind: "int",
    hint: "游戏端口。改完要同时放行 Windows 防火墙和云防火墙（主机配置页可做前者）。",
    spec: "1024–65535",
    scope: "重启服务器后生效",
    display: (s) => String(s.port),
    defaultText: () => "37015",
    defaultValue: 37015,
    assign: (s, value) => {
      s.port = Number(value);
    },
    editText: (s) => String(s.port),
    parse: (raw) => parseIntInRange(raw, 1024, 65535, "端口"),
  },
  {
    id: "password",
    label: "密码",
    kind: "password",
    engineName: "sv_password",
    hint: "留空表示不需要密码。密码以明文保存在本机设置文件里。",
    spec: "任意字符，留空 = 无密码",
    scope: "重启服务器后生效",
    display: (s) => (s.password.length === 0 ? "(未设置)" : `已设置（${s.password.length} 字符）`),
    defaultText: () => "(未设置)",
    defaultValue: "",
    assign: (s, value) => {
      s.password = String(value);
    },
    editText: (s) => s.password,
    parse: (raw) => ({ ok: true, value: raw }),
  },
  {
    id: "quotaString",
    label: "命令配额",
    kind: "int",
    engineName: "sv_quota_stringCmdsPerSecond",
    hint: "每秒钟允许的字符串命令上限，用来挡刷屏与滥用。",
    spec: "0–100000（0 = 关闭限流）",
    scope: "重启服务器后生效",
    display: (s) => `${s.quotaString} string/s`,
    defaultText: () => "256",
    defaultValue: 256,
    assign: (s, value) => {
      s.quotaString = Number(value);
    },
    editText: (s) => String(s.quotaString),
    parse: (raw) => parseIntInRange(raw, 0, 100000, "命令配额"),
  },
  {
    id: "quotaScript",
    label: "脚本配额",
    kind: "int",
    engineName: "sv_quota_scriptExecsPerSecond",
    hint: "每秒钟允许执行的脚本命令上限。",
    spec: "0–100000（0 = 关闭限流）",
    scope: "重启服务器后生效",
    display: (s) => `${s.quotaScript} script/s`,
    defaultText: () => "128",
    defaultValue: 128,
    assign: (s, value) => {
      s.quotaScript = Number(value);
    },
    editText: (s) => String(s.quotaScript),
    parse: (raw) => parseIntInRange(raw, 0, 100000, "脚本配额"),
  },
  {
    id: "logRetention",
    label: "日志保留份数",
    kind: "int",
    hint: "每次启动的日志各自存一份，这里设置保留最近几份。只影响本机，不传给服务端。",
    spec: "1–1000",
    scope: "下次启动时清理旧分片",
    display: (s) => `${s.logRetention} 份`,
    defaultText: () => "10",
    defaultValue: 10,
    assign: (s, value) => {
      s.logRetention = Number(value);
    },
    editText: (s) => String(s.logRetention),
    parse: (raw) => parseIntInRange(raw, 1, 1000, "日志保留份数"),
  },
  {
    id: "extra",
    label: "附加参数",
    kind: "text",
    hint: "原样追加到启动命令行，用来传本表没有的参数；不懂就留空。",
    spec: "整行原样传递，留空 = 不追加",
    scope: "重启服务器后生效",
    display: (s) => (s.extra.trim().length === 0 ? "(空)" : s.extra),
    defaultText: () => "(空)",
    defaultValue: "",
    assign: (s, value) => {
      s.extra = String(value);
    },
    editText: (s) => s.extra,
    parse: (raw) => ({ ok: true, value: raw.trim() }),
    warn: (s) => (s.extra.includes("+") && !s.extra.includes(" ") ? "看起来只有一个参数？多个参数之间要有空格" : null),
  },
];

export function fieldById(id: FieldId): FieldDef {
  const field = SETTINGS_FIELDS.find((f) => f.id === id);
  if (!field) throw new Error(`未知设置项：${id}`);
  return field;
}

/** Apply a validated value through the field table (CLI and TUI share this). */
export function applyFieldValue(settings: Settings, id: FieldId, raw: string): ParseResult {
  const field = fieldById(id);
  const parsed = field.parse(raw);
  if (!parsed.ok) return parsed;
  field.assign(settings, parsed.value);
  return parsed;
}
