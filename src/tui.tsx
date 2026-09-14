/**
 * Ink dashboard for the r5-server fleet.
 *
 * Routes: main (versions + instance + live log), detail (status), doctor
 * (environment checks + this run's health), config (host capability checklist),
 * settings, players, banlist (B), announce (n). Content areas fill the terminal
 * and scroll; Esc always returns to main.
 *
 * Actions that must print (start/upgrade/setup/...) are handed back to the CLI:
 * the dashboard unmounts, the command runs with normal stdout, then we come
 * back — to the same route.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Announcement, type AnnouncementsFile, collectAnnouncements, validateAnnouncement } from "./announcements";
import { EMPTY_CATALOG, type Catalog, loadCatalog, mapsForPlaylist } from "./catalog";
import { EMPTY_CFG_SCAN, type CfgEntry, type CfgScan, cfgOverridesFor, readCfgScan } from "./cfg";
import { type PlayerRow, fetchPlayers } from "./commands";
import {
  type Capability,
  type Health,
  type Section,
  type Tone,
  collectCapabilities,
  collectDetail,
  collectDoctor,
  collectHealth,
} from "./inspect";
import {
  type AnnounceForm,
  type KeyEvent,
  type PlayerTarget,
  type Route,
  type RouteContext,
  type UiState,
  ANNOUNCE_FIELDS,
  ANNOUNCE_FIELD_LABELS,
  announcementRow,
  effectiveCap,
  initialUi,
  routeKey,
} from "./keys";
import { formatUptime, parseServerTitle, summariseLog } from "./serverinfo";
import { SETTINGS_FIELDS, type FieldDef, type FieldId, fieldById } from "./settings-fields";
import { ROOT, defaultSettings, loadState, type State } from "./state";
import { isPidAlive, readTail, stripAnsi } from "./tap";
import { fitLine, padEndWidth, truncate } from "./ui";
import { discoverVersions, isNewer, parseVersion, type VersionInfo } from "./versions";
import * as win from "./win";

/** One line of console output produced by an action inside the dashboard. */
type ConsoleEntry = { text: string; kind: "head" | "out" | "error" };

export type RunCommand = (args: string[], onLine: (line: string) => void) => Promise<number>;

/** Persist one launch setting (validation + write happen in commands.ts). */
export type ApplySetting = (id: FieldId, raw: string) => { ok: boolean; error?: string; text: string };

type Snapshot = {
  state: State;
  versions: VersionInfo[];
  proc: win.ProcInfo | null;
  ports: string[];
  /** log file currently being watched (may not exist yet while starting) */
  logPath: string;
  logLines: string[];
  stateError: string;
  refreshedAt: number;
};

/**
 * Newest `logs/<版本>-<端口>-<时间戳>.log` shard (ticket 04: every run writes its
 * own shard, so the run id lives in the file name).
 */
function newestShard(version: string, port: number): string {
  if (version.length === 0) return "";
  const dir = join(ROOT, "logs");
  const prefix = `${version}-${port}-`;
  let newest = "";
  let newestMtime = -1;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return "";
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".log")) continue;
    const path = join(dir, name);
    try {
      const mtime = statSync(path).mtimeMs;
      if (mtime >= newestMtime) {
        newestMtime = mtime;
        newest = path;
      }
    } catch {
      continue;
    }
  }
  return newest;
}

/**
 * Which log the pane should follow.
 *
 * While a start is in flight the state file still holds the previous run, so the
 * newest shard is followed instead — the engine writes exactly that file, and the
 * pane then shows the boot output from the first line instead of dumping it in
 * one burst once the state catches up. Otherwise `runtime.logFile` wins: after a
 * stop it is the last run's shard.
 */
function resolveLogPath(state: State, selectedName: string, preferPredicted: boolean): string {
  const port = state.settings.port;
  const names = [selectedName, state.current ?? ""].filter((name) => name.length > 0);
  const fromState = state.runtime?.logFile ?? "";
  if (preferPredicted) {
    for (const name of names) {
      const shard = newestShard(name, port);
      if (shard) return shard;
    }
  }
  if (fromState && existsSync(fromState)) return fromState;
  for (const name of names) {
    const shard = newestShard(name, port);
    if (shard) return shard;
  }
  return fromState;
}

type PageData = {
  sections: Section[];
  problems: string[];
  loading: boolean;
  /** this run's engine logs (doctor route) */
  health: Health | null;
};

// ------------------------------------------------------------ text and time

function formatMB(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`;
}

/** 健康检查里的文件大小：`KB`，保留一位小数。 */
function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** Keep only the ports the server actually owns for gameplay (37xxx). */
function gameplayPorts(ports: string[], configured: number): { configured: string[]; other: string[] } {
  const picked: string[] = [];
  const rest: string[] = [];
  for (const endpoint of ports) {
    const port = Number(endpoint.slice(endpoint.lastIndexOf(":") + 1));
    if (port === configured) picked.push(endpoint);
    else rest.push(endpoint);
  }
  return { configured: picked, other: rest };
}

/** Newest version strictly newer than the current one (upgrade target). */
function newestUpgradeTarget(versions: VersionInfo[], current: string | null): string | null {
  const cur = versions.find((v) => v.name === current);
  if (!cur) return versions[0]?.name ?? null;
  const newer = versions.filter((v) => v.name !== cur.name && isNewer(v, cur));
  if (newer.length === 0) return null;
  return newer.toSorted((a, b) => (isNewer(a, b) ? -1 : 1))[0].name;
}

const TONE_COLOR: Record<Tone, string | undefined> = {
  green: "green",
  yellow: "yellow",
  red: "red",
  dim: undefined,
};

// ---------------------------------------------------------------- data hooks

function useSnapshot(
  follow: boolean,
  selIndex: number,
  preferPredicted: boolean,
): { snap: Snapshot; refresh: () => void } {
  const [snap, setSnap] = useState<Snapshot>(() => ({
    state: loadState(),
    versions: [],
    proc: null,
    ports: [],
    logPath: "",
    logLines: [],
    stateError: "",
    refreshedAt: Date.now(),
  }));

  const busy = useRef(false);

  const slow = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      let state: State;
      let stateError = "";
      try {
        state = loadState();
      } catch (err) {
        state = { current: null, settings: { ...defaultSettings }, runtime: null, history: [] };
        stateError = (err as Error).message;
      }
      const versions = discoverVersions(ROOT, { withSizes: false });
      const procs = await win.findDediProcessesAsync();
      const proc = procs.find((p) => p.path.toLowerCase().startsWith(ROOT.toLowerCase())) ?? null;
      const ports = proc ? await win.udpEndpointsAsync(proc.pid) : [];
      setSnap((prev) => ({
        ...prev,
        state,
        versions,
        proc,
        ports,
        logPath: resolveLogPath(state, versions[selRef.current]?.name ?? state.current ?? "", preferRef.current),
        stateError,
        refreshedAt: Date.now(),
      }));
    } finally {
      busy.current = false;
    }
  }, []);

  const selRef = useRef(selIndex);
  const preferRef = useRef(preferPredicted);
  useEffect(() => {
    selRef.current = selIndex;
    preferRef.current = preferPredicted;
  }, [selIndex, preferPredicted]);

  const fast = useCallback(() => {
    setSnap((prev) => {
      if (!follow) return prev;
      const file = resolveLogPath(
        prev.state,
        prev.versions[selRef.current]?.name ?? prev.state.current ?? "",
        preferRef.current,
      );
      if (!file) return prev;
      const lines = readTail(file, 500).map((line) => stripAnsi(line));
      if (file === prev.logPath && lines.length === prev.logLines.length) return prev;
      return { ...prev, logPath: file, logLines: lines };
    });
  }, [follow, selRef, preferRef]);

  useEffect(() => {
    void slow();
    const slowId = setInterval(() => void slow(), 2500);
    const fastId = setInterval(fast, 600);
    return () => {
      clearInterval(slowId);
      clearInterval(fastId);
    };
  }, [slow, fast]);

  /** Re-read state now (used after a settings save, instead of waiting a tick). */
  const refresh = useCallback(() => {
    void slow();
  }, [slow]);

  return { snap, refresh };
}

/** Load page data when the route changes (and on demand). */
function usePageData(route: Route, reloadKey: number, state: State): PageData {
  // `key` names the request the loaded data belongs to: `loading` is derived by
  // comparing it with the current key, so the effect only performs the
  // completion update instead of flipping a flag on and re-rendering twice.
  const key = `${route}:${reloadKey}`;
  const [data, setData] = useState<{
    key: string;
    sections: Section[];
    problems: string[];
    health: Health | null;
  }>({ key: "", sections: [], problems: [], health: null });
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (route === "main") return undefined;
    let cancelled = false;
    void (async () => {
      try {
        if (route === "detail") {
          const sections = await collectDetail(stateRef.current);
          if (!cancelled) setData({ key, sections, problems: [], health: null });
          return;
        }
        if (route === "doctor") {
          // Health and host checks are independent; the page also gets the
          // engine's own per-run logs (`platform/logs/server/latest.txt`).
          const [{ sections, problems }, health] = await Promise.all([
            collectDoctor(stateRef.current),
            collectHealth(stateRef.current),
          ]);
          const notes = [...problems];
          if (!health.latestOk) {
            notes.push("本次运行日志：读不到 platform/logs/server/latest.txt（引擎可能还没写过日志）");
          }
          if (health.error.exists && health.error.bytes > 0) {
            notes.push(`本次运行 error.log 非空（${health.error.bytes} 字节）：本次运行出现过错误`);
          }
          if (!cancelled) setData({ key, sections, problems: notes, health });
          return;
        }
        setData({ key, sections: [], problems: [], health: null });
      } catch (err) {
        if (!cancelled) {
          setData({
            key,
            sections: [
              {
                title: "读取失败",
                rows: [{ label: "错误", value: (err as Error).message, tone: "red" }],
              },
            ],
            problems: [],
            health: null,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route, key]);

  return {
    sections: data.sections,
    problems: data.problems,
    loading: route !== "main" && data.key !== key,
    health: data.health,
  };
}

/** Live player list, refreshed on demand (each fetch runs `status` on the engine). */
function usePlayers(
  route: Route,
  reloadKey: number,
  state: State,
): { players: PlayerRow[]; header: string[]; error: string; loading: boolean } {
  const key = `${route}:${reloadKey}`;
  const [result, setResult] = useState<{
    key: string;
    players: PlayerRow[];
    header: string[];
    error: string;
  }>({
    key: "",
    players: [],
    header: [],
    error: "",
  });
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (route !== "players") return undefined;
    let cancelled = false;
    void (async () => {
      const fetched = await fetchPlayers(stateRef.current);
      if (cancelled) return;
      setResult({
        key,
        players: fetched.players,
        header: fetched.header,
        error: fetched.error ?? "",
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [route, key]);

  return {
    players: result.players,
    header: result.header,
    error: result.error,
    loading: route === "players" && result.key !== key,
  };
}

/** Host-capability checklist for the config route. */
function useCapabilities(route: Route, reloadKey: number, state: State): { caps: Capability[]; loading: boolean } {
  const key = `${route}:${reloadKey}`;
  const [loaded, setLoaded] = useState<{ key: string; caps: Capability[] }>({ key: "", caps: [] });
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (route !== "config") return undefined;
    let cancelled = false;
    void (async () => {
      const list = await collectCapabilities(stateRef.current);
      if (!cancelled) setLoaded({ key, caps: list });
    })();
    return () => {
      cancelled = true;
    };
  }, [route, key]);

  return { caps: loaded.caps, loading: route === "config" && loaded.key !== key };
}

/** Announcement rows of the active version (`platform/datatable/chat_announcements.csv`). */
function useAnnouncements(
  route: Route,
  reloadKey: number,
  versionDir: string,
): { file: AnnouncementsFile | null; error: string; loading: boolean } {
  const key = `${route}:${reloadKey}`;
  const [data, setData] = useState<{ key: string; file: AnnouncementsFile | null; error: string }>({
    key: "",
    file: null,
    error: "",
  });
  const dirRef = useRef(versionDir);
  useEffect(() => {
    dirRef.current = versionDir;
  }, [versionDir]);

  useEffect(() => {
    if (route !== "announce") return undefined;
    let cancelled = false;
    void (async () => {
      if (dirRef.current.length === 0) {
        setData({ key, file: null, error: "没有可用的版本目录（先在主界面选一个版本）" });
        return;
      }
      try {
        const file = await collectAnnouncements(dirRef.current);
        if (!cancelled) setData({ key, file, error: "" });
      } catch (err) {
        if (!cancelled) setData({ key, file: null, error: (err as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route, key]);

  return { file: data.file, error: data.error, loading: route === "announce" && data.key !== key };
}

/**
 * Local ban list file. The engine only writes `banlist.json` once a real ban was
 * recorded, so "no file" is a normal state that the page explains.
 */
function useBanlist(
  route: Route,
  reloadKey: number,
  versionDir: string,
): { path: string; lines: string[]; note: string; loading: boolean } {
  const key = `${route}:${reloadKey}`;
  const [data, setData] = useState<{
    key: string;
    path: string;
    lines: string[];
    note: string;
  }>({ key: "", path: "", lines: [], note: "" });
  const dirRef = useRef(versionDir);
  useEffect(() => {
    dirRef.current = versionDir;
  }, [versionDir]);

  useEffect(() => {
    if (route !== "banlist") return undefined;
    let cancelled = false;
    void (async () => {
      // Same search order as the CLI: version root → platform/ → platform/cfg/.
      const file =
        [
          join(dirRef.current, "banlist.json"),
          join(dirRef.current, "platform", "banlist.json"),
          join(dirRef.current, "platform", "cfg", "banlist.json"),
        ].find((path) => existsSync(path)) ?? "";
      if (file.length === 0) {
        if (!cancelled) {
          setData({
            key,
            path: "",
            lines: [
              "版本目录根、platform/、platform/cfg/ 三处都没有 banlist.json。",
              "引擎只在真正写入过封禁后才会创建它（实测至今未出现）；机器人不可封禁，所以它不会凭空出现。",
              "按 r 会先发送 banlist_reload 让引擎热载名单，再重新读文件。",
            ],
            note: "未找到 banlist.json",
          });
        }
        return;
      }
      try {
        const raw = readFileSync(file, "utf8");
        let lines: string[];
        let note: string;
        try {
          const parsed: unknown = JSON.parse(raw);
          lines = JSON.stringify(parsed, null, 2).split(/\r?\n/);
          note = `${(statSync(file).size / 1024).toFixed(1)} KB · 键值原样呈现（字段名由引擎决定）`;
        } catch (err) {
          lines = raw.split(/\r?\n/);
          note = `不是合法 JSON（${(err as Error).message}）：原样显示文件内容`;
        }
        if (!cancelled) setData({ key, path: file, lines, note });
      } catch (err) {
        if (!cancelled) {
          setData({ key, path: file, lines: [], note: `读取失败：${(err as Error).message}` });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route, key]);

  return {
    path: data.path,
    lines: data.lines,
    note: data.note,
    loading: route === "banlist" && data.key !== key,
  };
}

// ---------------------------------------------------------------- components

function Field({
  label,
  value,
  tone,
  width,
}: {
  label: string;
  value: string;
  tone?: string;
  width: number;
}): React.ReactElement {
  const labelWidth = 10;
  return (
    <Text wrap="truncate">
      <Text dimColor>{padEndWidth(label, labelWidth)}</Text>
      <Text color={tone}>{truncate(value, Math.max(4, width - labelWidth))}</Text>
    </Text>
  );
}

function VersionRow({
  info,
  current,
  selected,
  width,
}: {
  info: VersionInfo;
  current: boolean;
  selected: boolean;
  width: number;
}): React.ReactElement {
  const parsed = parseVersion(info.name);
  const meta = info.gameVersion ?? "";
  // One string per row: Ink drops trailing spaces at each styled segment, so
  // padding must stay inside a single Text.
  const marker = selected ? "❯" : " ";
  const glyph = current ? "●" : " ";
  const nameCol = Math.max(12, width - 18);
  const head = `${marker} ${padEndWidth(info.name, nameCol)}${glyph}  ${meta}${parsed ? "" : " (无版本号)"}`;
  return (
    <Text color={selected ? "cyan" : undefined} bold={selected} wrap="truncate">
      {padEndWidth(head, width)}
    </Text>
  );
}

/** Flatten sections into renderable lines: titles + label/value rows. */
type Line = { text: string; tone?: Tone; title?: boolean };

function sectionLines(sections: Section[], labelWidth: number, width: number): Line[] {
  const lines: Line[] = [];
  for (const section of sections) {
    lines.push({ text: `▌ ${section.title}`, title: true });
    for (const row of section.rows) {
      const label = padEndWidth(row.label, labelWidth);
      lines.push({
        text: `  ${label}${truncate(row.value, Math.max(8, width - labelWidth - 4))}`,
        tone: row.tone,
      });
    }
    lines.push({ text: "" });
  }
  return lines;
}

/**
 * This run's own engine logs (`platform/logs/server/latest.txt` → `<uuid>/`).
 *
 * Severity is judged by file and by the text, never by the `Native(E)/(F)`
 * prefix — those lines carry normal boot output as well.
 */
function healthSection(health: Health, statsUpload: string): Section {
  const rows: Section["rows"] = [
    {
      label: "运行 id",
      value: health.runId || "(读不到 platform/logs/server/latest.txt)",
      tone: health.runId ? undefined : "yellow",
    },
    { label: "运行目录", value: health.runDir || "(未知)" },
  ];
  if (!health.error.exists) {
    rows.push({ label: "error.log", value: "不存在（引擎本次还没写过）", tone: "yellow" });
  } else if (health.error.bytes > 0) {
    const first = health.error.lines.find((line) => line.trim().length > 0) ?? "";
    rows.push({
      label: "error.log",
      value: `非空（${kb(health.error.bytes)}）：${first}`,
      tone: "red",
    });
  } else {
    rows.push({ label: "error.log", value: "空（本次运行没有错误）", tone: "green" });
  }
  rows.push({
    label: "warning.log",
    value: health.warning.exists
      ? `${kb(health.warning.bytes)} · 尾部 ${health.warning.lines.length} 行（启动诊断，非错误）`
      : "不存在",
  });
  rows.push({
    label: "script_warning.log",
    value: health.scriptWarning.exists
      ? health.scriptWarning.bytes > 0
        ? `有内容（${kb(health.scriptWarning.bytes)}）`
        : "空"
      : "不存在",
  });
  rows.push({ label: "对外上报", value: statsUpload });
  return { title: "本次运行（引擎自己的日志目录）", rows };
}

// ------------------------------------------------------------ settings page

/** True when an executed cfg file sets this setting's cvar to a different value. */
function cfgOverrideMismatch(scan: CfgScan, settings: State["settings"], id: FieldId): boolean {
  return cfgOverridesFor(scan, id).some((entry) => entry.value !== String(settings[id]));
}

/** One row of the settings list: label + current value, defaults dimmed. */
function SettingsRow({
  field,
  values,
  selected,
  dimmed,
  cfgMismatch,
  width,
  suffix,
}: {
  field: FieldDef;
  values: State["settings"];
  selected: boolean;
  dimmed: boolean;
  cfgMismatch: boolean;
  width: number;
  /** extra annotation appended to the value (e.g. the mode's family · title) */
  suffix: string;
}): React.ReactElement {
  const value = `${field.display(values)}${suffix}`;
  const isDefault = values[field.id] === field.defaultValue;
  const warn = field.warn ? field.warn(values) : null;
  const labelCol = 18;
  const head = `${selected ? "❯" : " "} ${padEndWidth(field.label, labelCol)}`;
  // One string per row: Ink strips trailing spaces at the end of a styled
  // segment, so padding followed by another Text node would collapse.
  const marker = `${isDefault ? "" : "  已修改"}${cfgMismatch ? "  cfg≠" : ""}${warn ? "  ⚠" : ""}`;
  const line = `${padEndWidth(truncate(`${head}${value}`, width - 10), width - 10)}${marker}`;
  return (
    <Text
      wrap="truncate"
      dimColor={dimmed}
      color={dimmed ? undefined : selected ? "cyan" : isDefault ? undefined : "green"}
      bold={selected && !dimmed}
    >
      {line}
    </Text>
  );
}

/**
 * Centered modal dialog for one setting.
 *
 * Centering is plain flow layout (`justifyContent`/`alignItems`) inside the page
 * box: Ink does not paint a background for absolutely positioned nodes, so the
 * page would show through around them.
 */
function SettingsDialog({
  field,
  mode,
  buffer,
  error,
  options,
  pick,
  viewRows,
  columns,
  rows,
  cfgOverrides,
}: {
  field: FieldDef;
  mode: "input" | "pick";
  buffer: string;
  error: string | null;
  options: { value: string; label: string; note?: string }[];
  pick: number;
  viewRows: number;
  columns: number;
  rows: number;
  cfgOverrides: CfgEntry[];
}): React.ReactElement {
  const width = Math.max(48, Math.min(88, columns - 12));
  const inner = width - 4;
  const caret = "\u258e";

  const cfgLines = cfgOverrides.slice(0, 2).map((entry) => ({
    text: `启动时同步到 ${entry.file} 第 ${entry.line} 行（现在是 ${entry.value}）`,
    tone: "yellow" as const,
  }));
  const listRows = mode === "pick" ? Math.min(viewRows, Math.max(3, options.length)) : 0;
  const start =
    mode === "pick"
      ? Math.max(0, Math.min(pick - Math.floor(listRows / 2), Math.max(0, options.length - listRows)))
      : 0;
  const slice = mode === "pick" ? options.slice(start, start + listRows) : [];

  type DialogLine = { text: string; tone?: "yellow" | "red" | "cyan"; bold?: boolean };
  const head: DialogLine = {
    text: `${mode === "pick" ? "选择" : "编辑"}：${field.label}${
      mode === "pick" ? `   共 ${options.length} 项 · 第 ${pick + 1} 项` : ""
    }`,
    tone: error ? "red" : "cyan",
    bold: true,
  };
  const body: DialogLine[] =
    mode === "pick"
      ? [
          ...slice.map((option, index) => {
            const absolute = start + index;
            const selected = absolute === pick;
            return {
              text: `${selected ? "❯" : " "} ${option.note ? `${padEndWidth(option.label, 34)}${option.note}` : option.label}`,
              tone: selected ? ("cyan" as const) : undefined,
              bold: selected,
            };
          }),
          { text: `取值：${field.spec}` },
        ]
      : [
          { text: `${truncate(buffer, inner - 2)}${caret}` },
          { text: `取值：${field.spec}` },
          error ? { text: `✘ ${error}`, tone: "red" as const } : { text: field.scope },
        ];
  const lines: DialogLine[] = [
    head,
    ...body,
    ...cfgLines,
    {
      text: mode === "pick" ? "↑↓ 选择 · 回车 确认 · Esc 取消" : "回车 保存 · 退格 删除 · Esc 取消",
    },
  ];

  // Every cell of the rectangle is written (padded spaces included): Ink only
  // overwrites the characters a node emits, so an unpadded line lets the page
  // behind the dialog show through.
  const height = Math.min(lines.length + 2, Math.max(6, rows - 6));

  return (
    <Box
      width={width}
      height={height}
      borderStyle="round"
      borderColor={error ? "red" : "cyan"}
      flexDirection="column"
      paddingX={1}
    >
      {lines.map((line) => (
        <Text key={line.text} wrap="truncate" color={line.tone} bold={line.bold}>
          {fitLine(line.text, inner)}
        </Text>
      ))}
    </Box>
  );
}

/** Confirmation for ban/unban: the engine answers nothing, so this is the last stop. */
function TargetDialog({
  action,
  target,
  columns,
  rows,
}: {
  action: "ban" | "unban";
  target: PlayerTarget;
  columns: number;
  rows: number;
}): React.ReactElement {
  const width = Math.max(52, Math.min(92, columns - 12));
  const inner = width - 4;
  type DialogLine = { text: string; tone?: "yellow" | "red" | "cyan"; bold?: boolean };
  const subject: DialogLine[] = [
    { text: `目标    ${target.name}`, bold: true },
    { text: `userid  ${target.userid}` },
    { text: `id64    ${target.uniqueid || "(无)"}` },
  ];
  const botHint: DialogLine[] = target.bot
    ? [
        {
          text: "注意：这是机器人（uniqueid=0）。实测引擎忽略对机器人的 ban/banid，命令会发出去但没有效果。",
          tone: "yellow" as const,
        },
      ]
    : [];
  const body: DialogLine[] =
    action === "ban"
      ? [
          ...subject,
          ...botHint,
          { text: `本地封禁命令 ban "${target.userid}"；引擎无回执，时长/原因不可用（属 Spire 侧）。` },
          { text: "回车后命令输出会进日志区，结果无法从本地确认。" },
        ]
      : [
          ...subject,
          ...botHint,
          { text: `本地解封命令 unban "${target.uniqueid || "<id64>"}"；引擎无回执，结果无法从本地确认。` },
        ];
  const lines: DialogLine[] = [
    {
      text: action === "ban" ? "封禁确认（本地控制台命令）" : "解封确认（本地控制台命令）",
      tone: "cyan",
      bold: true,
    },
    ...body,
    { text: "回车 执行 · Esc 取消", tone: "yellow" },
  ];
  const height = Math.min(lines.length + 2, Math.max(6, rows - 6));

  return (
    <Box width={width} height={height} borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1}>
      {lines.map((line) => (
        <Text key={line.text} wrap="truncate" color={line.tone} bold={line.bold}>
          {fitLine(line.text, inner)}
        </Text>
      ))}
    </Box>
  );
}

/** New-announcement form: one row of the CSV, validated live by the parser's rules. */
function AnnounceDialog({
  form,
  columns,
  rows,
}: {
  form: AnnounceForm;
  columns: number;
  rows: number;
}): React.ReactElement {
  const width = Math.max(56, Math.min(96, columns - 12));
  const inner = width - 4;
  const errors = validateAnnouncement(announcementRow(form));
  const focused = ANNOUNCE_FIELDS[Math.min(Math.max(0, form.field), ANNOUNCE_FIELDS.length - 1)];
  const hints: Record<keyof Announcement, string> = {
    kind: "rotate 轮播 / welcome 进场（← → 切换）",
    tag: "前缀，如 [Flowstate]；留空 = 无",
    text: "文案，最长 64 字符（含逗号也可以，写文件时会自动加引号）",
    color: "white/red/gold/green/cyan/rainbow/255 80 80；留空 = 默认",
    sustain: "完全可见秒数，留空 = 8",
    fade: "淡出秒数，留空 = 2",
    wait: "间隔秒数，留空 = 60（welcome 为 10）",
  };

  type DialogLine = { text: string; tone?: "yellow" | "red" | "cyan"; bold?: boolean };
  const head: DialogLine = { text: "新增公告（chat_announcements.csv）", tone: "cyan", bold: true };
  const rowsOf: DialogLine[] = ANNOUNCE_FIELDS.map((key) => {
    const active = key === focused;
    const value = form[key];
    return {
      text: `${active ? "❯" : " "} ${padEndWidth(ANNOUNCE_FIELD_LABELS[key], 14)}${fitLine(value.length > 0 ? value : "(空)", Math.max(8, inner - 20))}`,
      tone: active ? ("cyan" as const) : undefined,
      bold: active,
    };
  });
  const feedback: DialogLine[] =
    errors.length > 0
      ? [{ text: `✘ ${errors[0]}`, tone: "red" as const }]
      : [{ text: "✔ 校验通过（回车写入文件）", tone: "yellow" as const }];
  const lines: DialogLine[] = [
    head,
    ...rowsOf,
    { text: hints[focused] },
    ...feedback,
    { text: "↑↓ 换字段 · ←→ 切换 kind/color · 回车 保存 · Esc 取消" },
  ];
  const height = Math.min(lines.length + 2, Math.max(8, rows - 6));

  return (
    <Box
      width={width}
      height={height}
      borderStyle="round"
      borderColor={errors.length > 0 ? "red" : "cyan"}
      flexDirection="column"
      paddingX={1}
    >
      {lines.map((line) => (
        <Text key={line.text} wrap="truncate" color={line.tone} bold={line.bold}>
          {fitLine(line.text, inner)}
        </Text>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------- dashboard

export function Dashboard({
  initialFollow,
  initialRoute,
  runCommand,
  applySetting,
}: {
  initialFollow: boolean;
  initialRoute: Route;
  runCommand: RunCommand;
  applySetting: ApplySetting;
}): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = Math.max(72, stdout?.columns ?? 100);
  const rows = Math.max(20, stdout?.rows ?? 30);
  const [ui, setUi] = useState<UiState>(() => ({
    ...initialUi,
    follow: initialFollow,
    route: initialRoute,
  }));
  const [quit, setQuit] = useState(false);
  const [console_, setConsole] = useState<ConsoleEntry[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  // 时钟状态：渲染期间读 Date.now 会让输出不稳定，改成每秒推进一次的状态；
  // 它既刷新「多久之前」，也让日志摘要跟着重新读取。
  const [now, setNow] = useState(() => Date.now());
  const [reloadKey, setReloadKey] = useState(0);
  const starting = Boolean(running && running.startsWith("启动"));
  const { snap, refresh: refreshSnapshot } = useSnapshot(ui.follow, ui.sel, starting);
  const activeVersion = snap.versions.find((v) => v.name === (snap.state.current ?? "")) ?? snap.versions[0] ?? null;
  const catalog: Catalog = useMemo(
    () => (activeVersion ? loadCatalog(activeVersion.path) : EMPTY_CATALOG),
    [activeVersion],
  );
  const cfgScan: CfgScan = useMemo(
    () => (activeVersion ? readCfgScan(activeVersion.path) : EMPTY_CFG_SCAN),
    [activeVersion],
  );
  const page = usePageData(ui.route, reloadKey, snap.state);
  const { caps, loading: capsLoading } = useCapabilities(ui.route, reloadKey, snap.state);
  const playersData = usePlayers(ui.route, reloadKey, snap.state);
  const versionDir = activeVersion?.path ?? "";
  const announcementsData = useAnnouncements(ui.route, reloadKey, versionDir);
  const banlist = useBanlist(ui.route, reloadKey, versionDir);

  // 游标在读取时夹紧，而不是用 effect 回写：重新读取后行数会变少，过期的游标既不能
  // 越界（会让选择标记消失、漂到列表外），也不该为了回写它再触发一次渲染。
  const annCount = announcementsData.file?.rows.length ?? 0;
  const maxSel = Math.max(0, snap.versions.length - 1);
  const maxPlayer = Math.max(0, playersData.players.length - 1);
  const maxAnn = Math.max(0, annCount - 1);
  const view: UiState =
    ui.sel > maxSel || ui.sel < 0 || ui.playerCursor > maxPlayer || ui.annCursor > maxAnn
      ? {
          ...ui,
          sel: Math.min(Math.max(0, ui.sel), maxSel),
          playerCursor: Math.min(Math.max(0, ui.playerCursor), maxPlayer),
          annCursor: Math.min(Math.max(0, ui.annCursor), maxAnn),
        }
      : ui;

  useEffect(() => {
    if (quit) exit();
  }, [quit, exit]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /** Latest snapshot for the action callbacks; kept current after each commit. */
  const snapRef = useRef(snap);
  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);

  /** Run a CLI action inside the dashboard; its output lands in the log pane. */
  const runningRef = useRef(false);
  const execute = useCallback(
    async (label: string, argv: string[], after?: (code: number) => void): Promise<void> => {
      if (runningRef.current) return;
      runningRef.current = true;
      setConsole((prev) => [...prev, { text: `▶ ${label}   (r5-server ${argv.join(" ")})`, kind: "head" }]);
      setRunning(label);
      const sink = (line: string): void => {
        if (line.trim().length === 0) return;
        setConsole((prev) => [...prev, { text: line, kind: "out" }]);
      };
      let code = 0;
      try {
        code = await runCommand(argv, sink);
      } catch (err) {
        sink((err as Error).message);
        code = 1;
      } finally {
        runningRef.current = false;
        setRunning(null);
      }
      setConsole((prev) => [
        ...prev,
        code === 0 ? { text: `✔ ${label} 完成`, kind: "head" } : { text: `✘ ${label} 退出码 ${code}`, kind: "error" },
      ]);
      if (after) after(code);
      else {
        // The log pane is not on screen here, so every action reports itself.
        setNotice(
          code === 0
            ? { text: `已完成：${label}（输出见日志区）`, ok: true }
            : { text: `${label}：退出码 ${code}（见日志区）`, ok: false },
        );
      }
      // Every page re-reads its own data once the action settles (players list,
      // announcement rows, ban list ...), so the panel never shows stale rows.
      setReloadKey((k) => k + 1);
    },
    [runCommand],
  );

  /** Turn a router action into a captured command run. */
  const runAction = useCallback(
    (run: { args: string[]; label: string; next?: { args: string[]; label: string } }): void => {
      if (runningRef.current) return;
      if (run.next) {
        // Two-step action (e.g. bots clear → bots add --count N-1): run in order.
        const next = run.next;
        void (async () => {
          await execute(run.label, run.args);
          await execute(next.label, next.args);
        })();
        return;
      }
      const first = run.args[0];
      if (first === "upgrade") {
        const versions = snapRef.current.versions;
        const target = newestUpgradeTarget(versions, snapRef.current.state.current);
        if (!target) {
          setConsole((prev) => [...prev, { text: "已是最新版本，无需升级。", kind: "out" }]);
          return;
        }
        void execute(`升级到 ${target}`, ["upgrade", "--to", target, "--yes"]);
        return;
      }
      if (first === "start") {
        const name = snapRef.current.versions[view.sel]?.name;
        const needUse = Boolean(name) && snapRef.current.state.current !== name;
        void (async () => {
          if (needUse) await execute(`切换版本到 ${name}`, ["use", name]);
          await execute(run.label, run.args);
        })();
        return;
      }
      if (first === "ban" || first === "unban") {
        // 引擎对 ban/unban 完全没有回执：不许说“成功”，只说“已发送”。
        void execute(run.label, run.args, (code) =>
          setNotice(
            code === 0
              ? { text: "已发送（引擎无回执，结果无法从本地确认）；命令输出见日志区", ok: true }
              : { text: `发送失败：退出码 ${code}（见日志区）`, ok: false },
          ),
        );
        return;
      }
      if (first === "announce") {
        // 引擎对 bridge_chat_announce 无输出（命令存在）→ 只能如实说“已发送”。
        void execute(run.label, run.args, (code) =>
          setNotice(
            code === 0
              ? { text: "已发送广播（引擎无回执，命令存在但不回话）；效果需真人在场确认", ok: true }
              : { text: `广播未发送：退出码 ${code}（见日志区）`, ok: false },
          ),
        );
        return;
      }
      void execute(run.label, run.args);
    },
    [execute, view.sel],
  );

  const s = snap.state;
  const settings = s.settings;
  const version = snap.versions.find((v) => v.name === s.current);

  // ---- layout budget -------------------------------------------------------
  const headerHeight = 5;
  const leftPaneHeight = snap.versions.length === 0 ? 5 : snap.versions.length + 4;
  const rightPaneHeight = snap.proc ? 11 : 5;
  const panesHeight = Math.max(leftPaneHeight, rightPaneHeight);
  const footerHeight = 1;

  const pageRows = Math.max(3, rows - headerHeight - 2 - footerHeight);
  const annRows = Math.max(3, rows - headerHeight - 10);
  const banRows = Math.max(3, rows - headerHeight - 9);
  const logHeight = Math.max(4, rows - headerHeight - panesHeight - footerHeight);
  const logRows = Math.max(1, logHeight - 3);

  const proc = snap.proc;
  const metrics = proc ? parseServerTitle(proc.title) : {};
  const logFile = snap.logPath || s.runtime?.logFile;
  const logExists = Boolean(logFile && existsSync(logFile));
  /** Shard name of the log being followed: `logs/<版本>-<端口>-<runid>.log`. */
  const logShard = logFile ? `logs/${basename(logFile)}` : "";
  const summary = logFile && existsSync(logFile) ? summariseLog(logFile) : {};
  const ports = proc ? gameplayPorts(snap.ports, settings.port) : { configured: [], other: [] };
  const stale = Boolean(s.runtime?.pid) && !proc;
  const daemonAlive = Boolean(s.runtime?.logdPid && isPidAlive(s.runtime.logdPid));
  const secondsAgo = Math.max(0, Math.round((now - snap.refreshedAt) / 1000));

  // ---- page content --------------------------------------------------------
  // The doctor page carries the health block, whose labels are the app's
  // longest (`script_warning.log`), so its label column is wider.
  const pageLines =
    view.route === "detail" || view.route === "doctor"
      ? sectionLines(
          page.health
            ? [healthSection(page.health, fieldById("statsUpload").display(settings)), ...page.sections]
            : page.sections,
          view.route === "doctor" ? 19 : 12,
          columns - 6,
        )
      : [];
  const pageMaxScroll = Math.max(0, pageLines.length - pageRows);
  const pageSlice = pageLines.slice(view.pageScroll, view.pageScroll + pageRows);

  // Ban list page: one scrollable text page (the file's schema is the engine's).
  const banMaxScroll = Math.max(0, banlist.lines.length - banRows);
  const banSlice = banlist.lines.slice(view.pageScroll, view.pageScroll + banRows);

  // Maps of the playlist selected in the settings ([] = not a known mode).
  const playlistMaps = mapsForPlaylist(
    catalog.modes.flatMap((family) => family.modes),
    settings.playlist,
  );
  /** `fs_1v1（1v1 · FS 1v1）` — the setting row only carries the id otherwise. */
  let playlistSuffix = "";
  for (const family of catalog.modes) {
    const mode = family.modes.find((entry) => entry.id === settings.playlist);
    if (!mode) continue;
    const note = mode.title === family.title ? family.title : `${family.title} · ${mode.title}`;
    if (!fieldById("playlist").display(settings).includes(note)) playlistSuffix = `（${note}）`;
    break;
  }

  // ---- console stream ------------------------------------------------------
  const combined: { text: string; kind: "game" | "head" | "out" | "error" }[] = [
    ...snap.logLines.map((text) => ({ text, kind: "game" as const })),
    ...console_,
  ];

  // ---- input ---------------------------------------------------------------
  const ctx: RouteContext = {
    versionNames: snap.versions.map((v) => v.name),
    versionCount: snap.versions.length,
    logLineCount: combined.length,
    logRows,
    pageLineCount: pageLines.length,
    pageRows,
    caps: caps.map((c) => c.id),
    capEffective: Object.fromEntries(caps.map((c) => [c.id, c.enabled])),
    port: settings.port,
    settingsFields: SETTINGS_FIELDS,
    settingsValues: settings,
    settingsOptions: (field: FieldDef) => (field.options ? field.options({ catalog, settings }) : []),
    settingsRows: Math.max(3, rows - headerHeight - SETTINGS_FIELDS.length - 9),
    players: playersData.players.map((p) => ({
      userid: p.userid,
      uniqueid: p.uniqueid,
      name: p.name,
      bot: p.uniqueid === "0",
    })),
    playerRows: Math.max(3, rows - headerHeight - 9),
    announcements: (announcementsData.file?.rows ?? []).map((row) => ({
      kind: row.kind,
      tag: row.tag,
      text: row.text,
    })),
    annRows,
    banLineCount: banlist.lines.length,
    banRows,
    playlistMaps,
    running: Boolean(proc),
  };
  const ctxRef = useRef(ctx);
  // `ctx` is rebuilt every render, so the mirror has no dependency array: it runs
  // after each commit, which is exactly when the ref must be up to date.
  useEffect(() => {
    ctxRef.current = ctx;
  });

  useInput((input, key) => {
    const ev: KeyEvent = {
      input,
      up: key.upArrow,
      down: key.downArrow,
      left: key.leftArrow,
      right: key.rightArrow,
      pageUp: key.pageUp,
      pageDown: key.pageDown,
      home: key.home,
      end: key.end,
      escape: key.escape,
      return: key.return,
      space: input === " ",
      backspace: key.backspace,
      ctrl: key.ctrl,
    };
    const outcome = routeKey(view, ev, ctxRef.current);
    setUi(outcome.ui);
    if (outcome.quit) setQuit(true);
    // `r` is a page key (refresh) outside the settings editor: the router decides,
    // so browse-mode `r` there still restores a default.
    if (outcome.reload) setReloadKey((k) => k + 1);
    if (outcome.run) runAction(outcome.run);
    else if (outcome.save) {
      const field = fieldById(outcome.save.id);
      const result = applySetting(outcome.save.id, outcome.save.raw);
      setNotice(
        result.ok
          ? {
              text: `${outcome.notice ? `${outcome.notice} · ` : ""}已保存：${result.text}`,
              ok: true,
            }
          : { text: `未保存 · ${field.label}：${result.error ?? "取值无效"}`, ok: false },
      );
      if (result.ok) refreshSnapshot();
    } else if (outcome.notice) {
      setNotice({ text: outcome.notice, ok: true });
    }
  });

  const stateText = proc ? "运行中" : stale ? "已退出（状态文件仍有记录）" : "未运行";
  const stateTone = proc ? "green" : stale ? "yellow" : undefined;

  // Log window: game log + this session's action output, offset from the tail.
  const logEnd = Math.max(0, combined.length - view.scroll);
  const logStart = Math.max(0, logEnd - logRows);
  const visibleLogs = combined.slice(logStart, logEnd);

  const editMode = view.edit.mode;
  const editing = view.route === "settings" && editMode !== "browse";
  const selectedField = fieldById(SETTINGS_FIELDS[view.edit.cursor].id);
  const selectedCfg = view.route === "settings" ? cfgOverridesFor(cfgScan, selectedField.id) : [];
  const footer = view.consoleOpen
    ? "输入控制台命令（在服务器上执行，输出进日志区）· 回车 执行 · Esc 取消"
    : view.dialog
      ? view.dialog.kind === "announce"
        ? "↑↓ 换字段 · ←→ 切换 kind/color · 回车 保存（先过校验）· Esc 取消"
        : "回车 执行（输出进日志区）· Esc 取消"
      : view.route === "players"
        ? "↑↓ 选择玩家 · k 踢出 · b 封禁 · u 解封 · + 加机器人 · - 减 1 个 · c 清空 · r 刷新 · : 控制台 · Esc 返回 · q 退出"
        : view.route === "banlist"
          ? "↑↓/PgUp/PgDn 滚动 · Home/End 首尾 · r 刷新（先 banlist_reload 再重读文件）· Esc 返回 · q 退出"
          : view.route === "announce"
            ? "↑↓ 选择 · a 新增 · d 删除选中 · t 广播 · r 重新读取 · Esc 返回 · q 退出"
            : view.route === "settings"
              ? editMode === "input"
                ? "输入值 · 退格 删除 · 回车 保存（校验不过会提示）· Esc 取消"
                : editMode === "pick"
                  ? "↑↓/PgUp/PgDn 选择 · Home/End 首尾 · 回车 选中 · Esc 返回列表"
                  : "↑↓ 选择设置项 · 回车 编辑 · r 恢复默认 · x 立即切换模式（运行中）· Esc 返回主界面 · q 退出"
              : view.route === "main"
                ? `s 启动 · x 停止 · R 重启 · ↑↓/Enter 选版本 · U 升级 · p 玩家 · n 公告 · B 封禁名单 · : 控制台 · t 详情 · d 体检 · e 主机配置 · g 游戏设置 · PgUp/PgDn 翻日志 · q 退出`
                : view.route === "config"
                  ? "↑↓ 选择 · 空格 勾选 · 回车 应用（管理员/UAC）· r 重新探测 · Esc 返回 · q 退出"
                  : "↑↓/PgUp/PgDn 滚动 · Home/End 首尾 · r 刷新 · Esc 返回 · q 退出";

  const routeTitle: Record<Route, string> = {
    main: "",
    detail: "详情",
    doctor: "环境体检",
    config: "主机配置",
    settings: "游戏设置",
    players: "在线玩家",
    banlist: "封禁名单",
    announce: "公告",
  };

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {/* header */}
      <Box
        borderStyle="round"
        borderColor="cyan"
        flexDirection="column"
        paddingX={1}
        width={columns - 2}
        height={headerHeight}
      >
        <Text wrap="truncate">
          <Text bold color="cyan">
            R5Flowstate 服务器管理
          </Text>
          {view.route === "main" ? (
            <Text dimColor>{`   ${ROOT}`}</Text>
          ) : (
            <Text color="cyan">{`   ${routeTitle[view.route]}（Esc 返回）`}</Text>
          )}
        </Text>
        <Text wrap="truncate">
          <Text dimColor>当前版本 </Text>
          {version ? (
            <Text color="green" bold>
              {version.name}
            </Text>
          ) : (
            <Text color="red">未选择（主界面选中后回车）</Text>
          )}
          {version?.gameVersion ? <Text dimColor>{`  game ${version.gameVersion}`}</Text> : null}
          <Text dimColor>{`  · 刷新 ${secondsAgo}s 前`}</Text>
        </Text>
        <Text wrap="truncate">
          <Text dimColor>默认启动 </Text>
          <Text>{`UDP ${settings.port} · 地图 ${settings.map || "未设置"} · 模式 ${settings.playlist || "由玩家选择"} · 可见性 ${settings.visibility === 0 ? "离线" : settings.visibility === 1 ? "隐藏" : "公开"}`}</Text>
        </Text>
      </Box>

      {view.route === "main" ? (
        <>
          {/* versions + runtime */}
          <Box>
            <Box
              borderStyle="round"
              borderColor="blue"
              flexDirection="column"
              width={Math.max(28, Math.round((columns - 2) * 0.42))}
              paddingX={1}
            >
              <Text bold color="blue">
                版本（{snap.versions.length}）
              </Text>
              {snap.versions.length === 0 ? (
                <Text color="red">没有可用版本目录</Text>
              ) : (
                snap.versions.map((info, index) => (
                  <VersionRow
                    key={info.name}
                    info={info}
                    current={info.name === s.current}
                    selected={index === view.sel}
                    width={Math.max(28, Math.round((columns - 2) * 0.42)) - 4}
                  />
                ))
              )}
              <Text dimColor>{snap.versions.length > 0 ? "↑↓ 选择 · Enter 切换 · 新版本解压到此目录" : ""}</Text>
            </Box>

            <Box
              borderStyle="round"
              borderColor="magenta"
              flexDirection="column"
              width={columns - 2 - Math.max(28, Math.round((columns - 2) * 0.42))}
              paddingX={1}
            >
              <Text bold color="magenta">
                实例
              </Text>
              <Field
                label="状态"
                value={stateText}
                tone={stateTone}
                width={columns - 4 - Math.max(28, Math.round((columns - 2) * 0.42))}
              />
              {proc ? (
                <>
                  <Field
                    label="进程"
                    value={`pid ${proc.pid}   运行 ${formatUptime(s.runtime?.startedAt ?? "", proc.startedAt, true) || "—"}`}
                    width={columns - 4 - Math.max(28, Math.round((columns - 2) * 0.42))}
                  />
                  <Field
                    label="地图"
                    value={
                      metrics.map
                        ? `${metrics.map}${metrics.playlist ? `  (${metrics.playlist})` : ""}`
                        : summary.mapInit
                          ? `${summary.mapInit}${summary.gameState ? `  ${summary.gameState}` : ""}`
                          : summary.gameState || "加载中…"
                    }
                    width={columns - 4 - Math.max(28, Math.round((columns - 2) * 0.42))}
                  />
                  <Field
                    label="人数"
                    value={metrics.players ?? "托管模式下未上报"}
                    width={columns - 4 - Math.max(28, Math.round((columns - 2) * 0.42))}
                  />
                  <Field
                    label="CPU"
                    value={
                      metrics.cpuPercent
                        ? `${metrics.cpuPercent}%${metrics.frameMs ? `   ${metrics.frameMs} msec/帧` : ""}`
                        : `${Math.round(proc.cpuSeconds)} s 累计`
                    }
                    width={columns - 4 - Math.max(28, Math.round((columns - 2) * 0.42))}
                  />
                  <Field
                    label="内存"
                    value={`${formatMB(proc.workingSetMB)} 工作集 / ${formatMB(proc.privateMB)} 提交`}
                    width={columns - 4 - Math.max(28, Math.round((columns - 2) * 0.42))}
                  />
                  <Field
                    label="监听"
                    value={
                      ports.configured.length > 0
                        ? `UDP ${ports.configured.join(" ")}${ports.other.length ? `   (+${ports.other.length} 内部端口)` : ""}`
                        : "等待绑定…"
                    }
                    width={columns - 4 - Math.max(28, Math.round((columns - 2) * 0.42))}
                  />
                </>
              ) : (
                <Text dimColor>按 s 启动当前版本</Text>
              )}
              <Field
                label="日志"
                value={
                  daemonAlive
                    ? `运行中 (pid ${s.runtime?.logdPid})`
                    : logFile
                      ? "未运行（日志已停止更新）"
                      : "未启用托管控制台"
                }
                tone={daemonAlive ? "green" : undefined}
                width={columns - 4 - Math.max(28, Math.round((columns - 2) * 0.42))}
              />
            </Box>
          </Box>

          {/* log (fills the rest of the screen) */}
          <Box
            borderStyle="round"
            borderColor="gray"
            flexDirection="column"
            paddingX={1}
            width={columns - 2}
            height={logHeight}
          >
            <Text wrap="truncate">
              <Text bold color="gray">
                日志
              </Text>
              <Text
                dimColor
              >{`  ${view.follow ? "跟随中" : "已暂停"}${summary.lastStamp ? `   最新 [${summary.lastStamp}]s` : ""}`}</Text>
              {running ? <Text color="yellow">{`   ⏳ ${running} 运行中…`}</Text> : null}
              {view.scroll > 0 ? <Text color="yellow">{`   ↑ 已回溯 ${view.scroll} 行（End 回到最新）`}</Text> : null}
              {logFile ? (
                <Text dimColor>
                  {`   ${proc ? "本次运行" : "（上次运行）"} ${truncate(logShard, Math.max(16, columns - 74))}${logExists ? "" : "（等待引擎写入…）"}`}
                </Text>
              ) : null}
            </Text>
            {visibleLogs.length === 0 ? (
              <Text dimColor>
                {logFile
                  ? logExists
                    ? "（还没有输出）"
                    : "引擎正在启动，日志文件创建后会立刻开始跟随；面板里的操作结果也会显示在这里"
                  : "启动一次（默认托管控制台）后这里显示实时日志；面板里的操作结果也会显示在这里"}
              </Text>
            ) : (
              visibleLogs.map((entry, index) => (
                <Text
                  key={`${logStart + index}-${entry.text.slice(0, 16)}`}
                  wrap="truncate"
                  color={
                    entry.kind === "head"
                      ? "green"
                      : entry.kind === "error"
                        ? "red"
                        : entry.kind === "out"
                          ? "cyan"
                          : undefined
                  }
                  bold={entry.kind === "head"}
                >
                  {truncate(entry.text, columns - 6)}
                </Text>
              ))
            )}
          </Box>
        </>
      ) : (
        <Box
          borderStyle={editing || view.dialog ? undefined : "round"}
          borderColor={view.route === "config" ? "green" : "gray"}
          flexDirection="column"
          paddingX={1}
          width={columns - 2}
          height={rows - headerHeight - footerHeight}
        >
          {view.dialog ? (
            <Box
              flexDirection="column"
              width={columns - 4}
              height={rows - headerHeight - footerHeight}
              justifyContent="center"
              alignItems="center"
            >
              {view.dialog.kind === "announce" ? (
                <AnnounceDialog form={view.dialog.form} columns={columns} rows={rows} />
              ) : (
                <TargetDialog action={view.dialog.kind} target={view.dialog.target} columns={columns} rows={rows} />
              )}
            </Box>
          ) : editing ? (
            <Box
              flexDirection="column"
              width={columns - 4}
              height={rows - headerHeight - footerHeight}
              justifyContent="center"
              alignItems="center"
            >
              <SettingsDialog
                field={selectedField}
                mode={editMode === "pick" ? "pick" : "input"}
                buffer={view.edit.buffer}
                error={view.edit.error}
                options={ctx.settingsOptions(SETTINGS_FIELDS[view.edit.cursor])}
                pick={view.edit.pick}
                viewRows={ctx.settingsRows}
                columns={columns}
                rows={rows}
                cfgOverrides={selectedCfg}
              />
            </Box>
          ) : view.route === "players" ? (
            <>
              <Text wrap="truncate">
                <Text bold color="cyan">
                  在线玩家
                </Text>
                <Text dimColor>
                  {playersData.loading
                    ? "   读取中…（正在向服务器发 status）"
                    : `   ${playersData.players.filter((p) => p.uniqueid !== "0").length} 人在线 · ${playersData.players.filter((p) => p.uniqueid === "0").length} 个机器人`}
                </Text>
              </Text>
              {playersData.error ? (
                <Text color="red" wrap="truncate">{`  ${truncate(playersData.error, columns - 8)}`}</Text>
              ) : null}
              {playersData.header.length > 0 ? (
                <Text dimColor wrap="truncate">{`  ${truncate(playersData.header.join("  ·  "), columns - 8)}`}</Text>
              ) : null}
              {playersData.players.length === 0 ? (
                <Text dimColor wrap="truncate">
                  {"  当前没有玩家在线（服务器空闲）。有玩家进来后按 r 刷新；按 + 可以填充机器人。"}
                </Text>
              ) : (
                <>
                  <Text
                    dimColor
                    wrap="truncate"
                  >{`  ${padEndWidth("#", 4)}${padEndWidth("userid", 8)}${padEndWidth("id64", 19)}${padEndWidth("ping", 6)}${padEndWidth("状态", 12)}名字`}</Text>
                  {playersData.players.map((player, index) => {
                    const selected = index === view.playerCursor;
                    const bot = player.uniqueid === "0";
                    const line = `${padEndWidth(selected ? "❯" : " ", 4)}${padEndWidth(player.userid, 8)}${padEndWidth(player.uniqueid, 19)}${padEndWidth(player.ping, 6)}${padEndWidth(player.state, 12)}${player.name}`;
                    return (
                      <Text key={player.userid} color={selected ? "cyan" : undefined} bold={selected} wrap="truncate">
                        {truncate(`  ${line}`, columns - 8)}
                        {bot ? <Text dimColor>{"  [机器人]"}</Text> : null}
                      </Text>
                    );
                  })}
                </>
              )}
              <Text dimColor wrap="truncate">
                {
                  "  k 踢出 · b 封禁（先确认；引擎无回执）· u 解封（id64）· + 加 1 个机器人 · - 减 1 个 · c 清空机器人 · : 控制台"
                }
              </Text>
              {notice ? (
                <Text
                  color={notice.ok ? "green" : "red"}
                  wrap="truncate"
                >{`  ${truncate(notice.text, columns - 8)}`}</Text>
              ) : null}
            </>
          ) : view.route === "banlist" ? (
            <>
              <Text wrap="truncate">
                <Text bold color="cyan">
                  封禁名单
                </Text>
                <Text dimColor>{`   本地 banlist.json · ${banlist.loading ? "读取中…" : banlist.note}`}</Text>
              </Text>
              {banlist.path ? (
                <Text dimColor wrap="truncate">{`  文件：${truncate(banlist.path, columns - 12)}`}</Text>
              ) : null}
              {banSlice.map((line, index) => (
                <Text key={`${view.pageScroll + index}`} wrap="truncate">
                  {`  ${truncate(line, columns - 8)}`}
                </Text>
              ))}
              {banlist.lines.length === 0 && !banlist.loading ? <Text dimColor>{"  （没有可显示的内容）"}</Text> : null}
              <Text dimColor wrap="truncate">
                {
                  "  r 会先发送 banlist_reload（引擎热载名单，无回执）再重新读文件 · 机器人不可封禁，所以名单里不会出现它们"
                }
              </Text>
              {banMaxScroll > 0 ? (
                <Text dimColor>{`  （已滚动到第 ${view.pageScroll + 1} 行 / 共 ${banlist.lines.length} 行）`}</Text>
              ) : null}
              {notice ? (
                <Text
                  color={notice.ok ? "green" : "red"}
                  wrap="truncate"
                >{`  ${truncate(notice.text, columns - 8)}`}</Text>
              ) : null}
            </>
          ) : view.route === "announce" ? (
            <>
              <Text wrap="truncate">
                <Text bold color="cyan">
                  公告
                </Text>
                <Text dimColor>
                  {`   ${annCount} 条 · ${announcementsData.loading ? "读取中…" : "platform/datatable/chat_announcements.csv"}`}
                </Text>
              </Text>
              <Text dimColor wrap="truncate">
                {announcementsData.file ? `  文件：${truncate(announcementsData.file.path, columns - 12)}` : ""}
              </Text>
              {announcementsData.error ? (
                <Text color="red" wrap="truncate">{`  ${truncate(announcementsData.error, columns - 8)}`}</Text>
              ) : null}
              {(announcementsData.file?.rows ?? [])
                .slice(view.annScroll, view.annScroll + annRows)
                .map((row, index) => {
                  const absolute = view.annScroll + index;
                  const selected = absolute === view.annCursor;
                  const tail = `${row.color || "默认色"} · 停留 ${row.sustain || 8}s · 淡出 ${row.fade || 2}s · 间隔 ${row.wait || (row.kind === "rotate" ? 60 : 10)}s`;
                  const head = `${selected ? "❯" : " "} ${padEndWidth(row.kind, 8)}${padEndWidth(truncate(row.tag || "-", 14), 14)}${truncate(row.text, Math.max(12, columns - 78))}`;
                  return (
                    <Text
                      key={`${row.kind}-${absolute}`}
                      color={selected ? "cyan" : undefined}
                      bold={selected}
                      wrap="truncate"
                    >
                      {truncate(`  ${head}  ${tail}`, columns - 6)}
                    </Text>
                  );
                })}
              {annCount === 0 && !announcementsData.loading && !announcementsData.error ? (
                <Text dimColor>{"  没有解析到公告行（文件可能只有注释与表头）。按 a 新增一条。"}</Text>
              ) : null}
              <Text dimColor wrap="truncate">
                {"  改动在 changelevel 或重启后生效（引擎文件头自述）· t 触发广播：引擎无回执，效果需真人在场确认"}
              </Text>
              {notice ? (
                <Text
                  color={notice.ok ? "green" : "red"}
                  wrap="truncate"
                >{`  ${truncate(notice.text, columns - 8)}`}</Text>
              ) : null}
            </>
          ) : view.route === "settings" ? (
            <>
              <Text wrap="truncate">
                <Text bold color="cyan">
                  启动设置
                </Text>
                <Text dimColor>
                  {`   ${SETTINGS_FIELDS.length} 项 · 每项都是启动参数，改完需重启服务器 · 清单来自当前版本`}
                </Text>
              </Text>
              {SETTINGS_FIELDS.map((field, index) => (
                <SettingsRow
                  key={field.id}
                  field={field}
                  values={settings}
                  selected={index === view.edit.cursor}
                  dimmed={editing}
                  cfgMismatch={cfgOverrideMismatch(cfgScan, settings, field.id)}
                  width={columns - 8}
                  suffix={field.id === "playlist" ? playlistSuffix : ""}
                />
              ))}
              <Text dimColor wrap="truncate">{`  ${selectedField.hint}`}</Text>
              <Text dimColor wrap="truncate">
                {`  默认值：${selectedField.defaultText(settings)}   ·   ${selectedField.scope}`}
              </Text>
              {selectedField.id === "map" && snap.proc ? (
                <Text dimColor wrap="truncate">
                  {`  立即换图（不重启、不掉人）：: changelevel ${settings.map || "<stem>"}`}
                </Text>
              ) : null}
              {selectedField.id === "playlist" ? (
                <Text dimColor wrap="truncate">
                  {`  x 立即切换模式（bridge_setmode，运行中生效）${playlistMaps.length > 0 ? ` · 该模式 ${playlistMaps.length} 张图` : ""}`}
                </Text>
              ) : null}
              {selectedCfg.length > 0 ? (
                <Text color="yellow" wrap="truncate">
                  {`  ⚠ ${selectedCfg[0].file} 第 ${selectedCfg[0].line} 行是 ${selectedCfg[0].value}；启动时会写成面板值，cfg 不会覆盖这里`}
                </Text>
              ) : null}
              {notice ? (
                <Text
                  color={notice.ok ? "green" : "red"}
                  wrap="truncate"
                >{`  ${truncate(notice.text, columns - 8)}`}</Text>
              ) : null}
            </>
          ) : view.route === "config" ? (
            <>
              <Text wrap="truncate">
                <Text bold color="green">
                  选择要启用的能力
                </Text>
                <Text dimColor>{"   空格 勾选 · 回车 应用 · 未勾选的项会跳过"}</Text>
              </Text>
              {capsLoading && caps.length === 0 ? (
                <Text dimColor>正在探测主机状态…</Text>
              ) : (
                caps.map((cap, index) => {
                  const effective = effectiveCap(view, ctx, cap.id);
                  const pending = effective !== cap.enabled;
                  const cursor = index === view.cfgCursor;
                  return (
                    <React.Fragment key={cap.id}>
                      <Text wrap="truncate">
                        <Text color={cursor ? "cyan" : undefined} bold={cursor}>
                          {`${cursor ? "❯" : " "} [${effective ? "x" : " "}] ${cap.label}`}
                        </Text>
                        {pending ? <Text color="yellow">{"  ← 待应用"}</Text> : null}
                      </Text>
                      <Text dimColor wrap="truncate">
                        {`      ${truncate(cap.detail, columns - 12)}`}
                      </Text>
                    </React.Fragment>
                  );
                })
              )}
              <Text dimColor wrap="truncate">
                {"  应用会调用 setup：需要管理员权限（会弹 UAC）；云防火墙仍需在腾讯云控制台单独放行。"}
              </Text>
            </>
          ) : page.loading ? (
            <Text dimColor>读取中…</Text>
          ) : (
            <>
              {pageSlice.map((line, index) => (
                <Text
                  key={`${view.pageScroll + index}`}
                  wrap="truncate"
                  color={line.title ? "cyan" : TONE_COLOR[line.tone ?? "dim"]}
                >
                  {line.title ? line.text : line.text.trimEnd()}
                </Text>
              ))}
              {view.route === "doctor" ? (
                page.problems.length === 0 ? (
                  <Text color="green">{"  没有发现明显问题。"}</Text>
                ) : (
                  <>
                    <Text color="yellow">{"  待处理："}</Text>
                    {page.problems.map((problem) => (
                      <Text key={problem} wrap="truncate" color="yellow">
                        {`    - ${truncate(problem, columns - 10)}`}
                      </Text>
                    ))}
                  </>
                )
              ) : null}
              {pageMaxScroll > 0 ? (
                <Text dimColor>{`  （已滚动到第 ${view.pageScroll + 1} 行 / 共 ${pageLines.length} 行）`}</Text>
              ) : null}
            </>
          )}
        </Box>
      )}

      {/* console prompt */}
      {view.consoleOpen ? (
        <Text wrap="truncate">
          <Text color="cyan" bold>
            {"控制台▸ "}
          </Text>
          <Text>{`${truncate(view.consoleBuffer, columns - 14)}▎`}</Text>
        </Text>
      ) : null}

      {/* footer */}
      <Text wrap="truncate">
        <Text dimColor>{footer}</Text>
      </Text>
      {snap.stateError ? <Text color="red">{truncate(snap.stateError, columns - 2)}</Text> : null}
    </Box>
  );
}
