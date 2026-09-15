import { type Announcement, type AnnouncementKind, validateAnnouncement } from "./announcements";
/**
 * Pure key router for the dashboard.
 *
 * Kept free of React so the navigation/scroll/toggle rules are plain functions.
 */
import type { CapabilityId } from "./inspect";
import { type EditState, type EditEvent, initialEditState, isPrintable, settingsKey } from "./settings-edit";
import type { FieldDef, FieldId, FieldOption } from "./settings-fields";
import type { Settings } from "./state";
import {
  type TextField,
  caretToEdge,
  deleteAtCaret,
  deleteBefore,
  insertText,
  moveCaret,
  textField,
} from "./text-field";

export type Route = "main" | "detail" | "doctor" | "config" | "settings" | "players" | "banlist" | "announce";

/** One player as the router sees it; `bot` is `uniqueid === "0"` (发实测判据). */
export type PlayerTarget = { userid: string; uniqueid: string; name: string; bot: boolean };

/** The announcement form is one CSV row, the focused column index and that cell's caret. */
export type AnnounceForm = Announcement & { field: number; caret: number };

/** The modal slot: every page shares one dialog at a time. */
export type DialogState =
  | { kind: "ban"; target: PlayerTarget }
  | { kind: "unban"; target: PlayerTarget }
  | { kind: "announce"; form: AnnounceForm };

/** CSV column order (the file's own header) — drives form navigation. */
export const ANNOUNCE_FIELDS: (keyof Announcement)[] = ["kind", "tag", "text", "color", "sustain", "fade", "wait"];

/** Chinese labels for the form rows; the schema names stay visible next to them. */
export const ANNOUNCE_FIELD_LABELS: Record<keyof Announcement, string> = {
  kind: "种类",
  tag: "前缀",
  text: "文案",
  color: "颜色",
  sustain: "停留",
  fade: "淡出",
  wait: "间隔",
};

/** `color` values the engine documents in the CSV header (blank = 默认). */
export const ANNOUNCE_COLORS = ["", "white", "red", "gold", "green", "cyan", "rainbow", "255 80 80"];

const ANNOUNCE_KINDS: AnnouncementKind[] = ["rotate", "welcome"];

export type UiState = {
  route: Route;
  /** index into the version list */
  sel: number;
  follow: boolean;
  /** lines scrolled up from the newest line (0 = tail) */
  scroll: number;
  /** rows scrolled from the top of the detail/doctor/banlist page */
  pageScroll: number;
  /** cursor in the host-config checklist */
  cfgCursor: number;
  /** desired state per capability; missing key = keep the detected value */
  cfgDesired: Partial<Record<CapabilityId, boolean>>;
  /** cursor/mode of the game-settings page */
  edit: EditState;
  /** cursor in the player list */
  playerCursor: number;
  /** one-line console prompt (``:`` opens it), with its own caret */
  consoleOpen: boolean;
  consoleBuffer: TextField;
  /** selected row of the announcements list */
  annCursor: number;
  /** first visible row of the announcements list */
  annScroll: number;
  /** open modal dialog, if any */
  dialog: DialogState | null;
};

/** A dashboard key press: the editor's keys, plus the space toggle and the two
 *  horizontal arrows (the announcement form cycles enum cells with them). */
export type KeyEvent = EditEvent & { space: boolean; left: boolean; right: boolean };

export type RouteContext = {
  versionNames: string[];
  versionCount: number;
  /** total log lines currently held */
  logLineCount: number;
  /** how many log rows fit on screen */
  logRows: number;
  /** total lines of the detail/doctor page */
  pageLineCount: number;
  /** how many rows fit on screen */
  pageRows: number;
  caps: CapabilityId[];
  /** effective (checked) state of each capability, after user edits */
  capEffective: Record<string, boolean>;
  port: number;
  settingsFields: FieldDef[];
  settingsValues: Settings;
  settingsOptions: (field: FieldDef) => FieldOption[];
  /** rows available for the picker/editor area */
  settingsRows: number;
  /** players currently listed (for kick/ban/unban targets) */
  players: PlayerTarget[];
  playerRows: number;
  /** announcements currently listed (kind/tag/text previews) */
  announcements: { kind: string; tag: string; text: string }[];
  annRows: number;
  /** rendered lines of the banlist page */
  banLineCount: number;
  banRows: number;
  /** maps of the playlist currently selected in the settings ([] = unknown mode) */
  playlistMaps: string[];
  /** a dedi instance is running: the live mode switch is available */
  running: boolean;
};

export type RouteOutcome = {
  ui: UiState;
  /** a CLI invocation to run (output goes to the log pane) */
  run?: { args: string[]; label: string; next?: { args: string[]; label: string } };
  /** re-read the current page's data */
  reload?: boolean;
  /** an accepted setting edit, to be persisted by the caller */
  save?: { id: FieldId; raw: string };
  notice?: string;
  quit?: boolean;
};

export const initialUi: UiState = {
  route: "main",
  sel: 0,
  follow: true,
  scroll: 0,
  pageScroll: 0,
  cfgCursor: 0,
  cfgDesired: {},
  edit: initialEditState,
  playerCursor: 0,
  consoleOpen: false,
  consoleBuffer: textField(""),
  annCursor: 0,
  annScroll: 0,
  dialog: null,
};

function clampScroll(scroll: number, total: number, rows: number): number {
  const max = Math.max(0, total - rows);
  return Math.min(Math.max(0, scroll), max);
}

/** Log window: `delta` > 0 walks back into history. */
function scrollLog(ui: UiState, delta: number, ctx: RouteContext): UiState {
  const next = clampScroll(ui.scroll + delta, ctx.logLineCount, ctx.logRows);
  return { ...ui, scroll: next, follow: next === 0 };
}

/** Paged content: `delta` > 0 moves down the page. */
function scrollPage(ui: UiState, delta: number, total: number, rows: number): UiState {
  return { ...ui, pageScroll: clampScroll(ui.pageScroll + delta, total, rows) };
}

/** List cursor + window, kept in sync so the selection never scrolls off screen. */
function moveCursor(
  cursor: number,
  scroll: number,
  delta: number,
  count: number,
  rows: number,
): { cursor: number; scroll: number } {
  const next = Math.min(Math.max(0, cursor + delta), Math.max(0, count - 1));
  let top = scroll;
  if (next < top) top = next;
  if (next >= top + rows) top = next - rows + 1;
  return { cursor: next, scroll: Math.max(0, top) };
}

const DENY_FLAG: Record<CapabilityId, string> = {
  firewall: "--no-firewall",
  pagefile: "--no-pagefile",
  defender: "--no-defender",
  task: "--no-task",
  power: "--no-power",
};

function configApplyArgv(ui: UiState, ctx: RouteContext): string[] {
  const deny = ctx.caps.filter((id) => !effectiveCap(ui, ctx, id)).map((id) => DENY_FLAG[id]);
  return ["setup", "--ports", String(ctx.port), ...deny];
}

export function effectiveCap(ui: UiState, ctx: RouteContext, id: CapabilityId): boolean {
  const desired = ui.cfgDesired[id];
  return desired === undefined ? ctx.capEffective[id] : desired;
}

function applyToggle(ui: UiState, ctx: RouteContext): UiState {
  const id = ctx.caps[ui.cfgCursor];
  if (!id) return ui;
  const next = !effectiveCap(ui, ctx, id);
  return { ...ui, cfgDesired: { ...ui.cfgDesired, [id]: next } };
}

// ------------------------------------------------------------- modal dialogs

/** The CSV row a form describes (live validation and the save path share it). */
export function announcementRow(form: AnnounceForm): Announcement {
  return {
    kind: form.kind,
    tag: form.tag,
    text: form.text,
    color: form.color,
    sustain: form.sustain,
    fade: form.fade,
    wait: form.wait,
  };
}

/** One cell of the form, caret included. `kind` only ever receives the two documented values. */
function withCell(form: AnnounceForm, key: keyof Announcement, cell: TextField): AnnounceForm {
  const next: AnnounceForm = { ...form, caret: cell.caret };
  if (key === "tag") next.tag = cell.text;
  else if (key === "text") next.text = cell.text;
  else if (key === "color") next.color = cell.text;
  else if (key === "sustain") next.sustain = cell.text;
  else if (key === "fade") next.fade = cell.text;
  else if (key === "wait") next.wait = cell.text;
  else next.kind = cell.text === "welcome" ? "welcome" : "rotate";
  return next;
}

function nextInList<T>(values: T[], current: T, step: number): T {
  const found = values.indexOf(current);
  const index = found < 0 ? 0 : (found + step + values.length) % values.length;
  return values[index];
}

/** `announcements add` argv; blank cells fall back to the engine defaults. */
function announceAddArgv(form: AnnounceForm): string[] {
  const args = ["announcements", "add", "--kind", form.kind, "--text", form.text];
  if (form.tag.trim().length > 0) args.push("--tag", form.tag.trim());
  if (form.color.trim().length > 0) args.push("--color", form.color.trim());
  for (const key of ["sustain", "fade", "wait"] as const) {
    if (form[key].trim().length > 0) args.push(`--${key}`, form[key].trim());
  }
  return args;
}

/** Ban/unban are confirmed first: the engine answers nothing, so no undo exists. */
function confirmKey(ui: UiState, ev: KeyEvent, dialog: Extract<DialogState, { kind: "ban" | "unban" }>): RouteOutcome {
  if (ev.escape) return { ui: { ...ui, dialog: null } };
  const target = dialog.target;
  if (ev.return) {
    return dialog.kind === "ban"
      ? {
          ui: { ...ui, dialog: null },
          run: { args: ["ban", target.userid], label: `封禁 ${target.name}` },
        }
      : {
          ui: { ...ui, dialog: null },
          run: { args: ["unban", target.uniqueid], label: `解封 ${target.name}（账号 ${target.uniqueid}）` },
        };
  }
  return { ui };
}

function announceFormKey(ui: UiState, ev: KeyEvent, dialog: Extract<DialogState, { kind: "announce" }>): RouteOutcome {
  const form = dialog.form;
  const field = ANNOUNCE_FIELDS[Math.min(Math.max(0, form.field), ANNOUNCE_FIELDS.length - 1)];
  const edit = (next: AnnounceForm): RouteOutcome => ({ ui: { ...ui, dialog: { kind: "announce", form: next } } });
  const focus = (index: number): AnnounceForm => {
    const next = ANNOUNCE_FIELDS[Math.min(Math.max(0, index), ANNOUNCE_FIELDS.length - 1)];
    return { ...form, field: Math.min(Math.max(0, index), ANNOUNCE_FIELDS.length - 1), caret: form[next].length };
  };
  // `kind`/`color` are pick-lists: ←→ 换值 is their own shortcut, so the caret only
  // moves on the free-text rows. `color` still accepts typing (自定义 RGB)，caret 停在末尾。
  const caretFree = field !== "kind" && field !== "color";
  const cell: TextField = { text: form[field], caret: form.caret };

  if (ev.escape) return { ui: { ...ui, dialog: null } };
  if (ev.up || ev.pageUp) return edit(focus(form.field - 1));
  if (ev.down || ev.pageDown) return edit(focus(form.field + 1));
  if (ev.home) return edit(focus(0));
  if (ev.end) return edit(focus(ANNOUNCE_FIELDS.length - 1));
  if (field === "kind" && (ev.left || ev.right || ev.space)) {
    const kind = nextInList(ANNOUNCE_KINDS, form.kind, ev.left ? -1 : 1);
    return edit(withCell(form, "kind", textField(kind)));
  }
  if (field === "color" && (ev.left || ev.right)) {
    return edit(withCell(form, "color", textField(nextInList(ANNOUNCE_COLORS, form.color, ev.left ? -1 : 1))));
  }
  if (caretFree && ev.left) return edit(withCell(form, field, moveCaret(cell, -1)));
  if (caretFree && ev.right) return edit(withCell(form, field, moveCaret(cell, 1)));
  if (field !== "kind" && ev.backspace) return edit(withCell(form, field, deleteBefore(cell)));
  if (field !== "kind" && ev.delete) return edit(withCell(form, field, deleteAtCaret(cell)));
  if (ev.return) {
    const errors = validateAnnouncement(announcementRow(form));
    if (errors.length > 0) return { ui, notice: `未保存：${errors[0]}` };
    return {
      ui: { ...ui, dialog: null },
      run: { args: announceAddArgv(form), label: `新增公告：${form.text}` },
    };
  }
  if (field !== "kind" && isPrintable(ev.input)) return edit(withCell(form, field, insertText(cell, ev.input)));
  return { ui };
}

// ------------------------------------------------------------ settings page

/** `x` on the map row: change level right now (console `changelevel <map>`). */
function switchMap(ui: UiState, ctx: RouteContext): RouteOutcome {
  const map = ctx.settingsValues.map.trim();
  if (map.length === 0) return { ui, notice: "先在「地图」里选一张图，再按 x 立即换图" };
  if (!ctx.running) return { ui, notice: "服务器未运行：换图只能对运行中的实例执行，先按 s 启动" };
  return { ui, run: { args: ["console", `changelevel ${map}`], label: `立即换图：${map}` } };
}

/** `x`: apply the selected playlist with `bridge_setmode` (运行期命令). */
function switchMode(ui: UiState, ctx: RouteContext): RouteOutcome {
  const playlist = ctx.settingsValues.playlist.trim();
  const map = ctx.settingsValues.map.trim();
  if (playlist.length === 0) {
    return { ui, notice: "先在「模式」里选一个玩法，再按 x 立即切换" };
  }
  if (!ctx.running) {
    return { ui, notice: "服务器未运行：模式只能在运行中切换，先按 s 启动" };
  }
  // Only pass a map the chosen playlist actually ships; otherwise let the CLI
  // fall back to the mode's own default map.
  const known = ctx.playlistMaps.length > 0 && ctx.playlistMaps.includes(map);
  const args = known ? ["mode", "set", playlist, map] : ["mode", "set", playlist];
  return { ui, run: { args, label: `立即切换模式：${playlist}${known ? ` ${map}` : "（用该模式默认地图）"}` } };
}

export function routeKey(ui: UiState, ev: KeyEvent, ctx: RouteContext): RouteOutcome {
  // The console prompt owns the keyboard while it is open: `q` is a character.
  if (ui.consoleOpen) {
    const line = ui.consoleBuffer;
    if (ev.escape) return { ui: { ...ui, consoleOpen: false, consoleBuffer: textField("") } };
    if (ev.left) return { ui: { ...ui, consoleBuffer: moveCaret(line, -1) } };
    if (ev.right) return { ui: { ...ui, consoleBuffer: moveCaret(line, 1) } };
    if (ev.home) return { ui: { ...ui, consoleBuffer: caretToEdge(line, "start") } };
    if (ev.end) return { ui: { ...ui, consoleBuffer: caretToEdge(line, "end") } };
    if (ev.backspace) return { ui: { ...ui, consoleBuffer: deleteBefore(line) } };
    if (ev.delete) return { ui: { ...ui, consoleBuffer: deleteAtCaret(line) } };
    if (ev.return) {
      const command = line.text.trim();
      const closed = { ...ui, consoleOpen: false, consoleBuffer: textField("") };
      if (command.length === 0) return { ui: closed };
      return { ui: closed, run: { args: ["console", command], label: `控制台：${command}` } };
    }
    if (isPrintable(ev.input)) return { ui: { ...ui, consoleBuffer: insertText(line, ev.input) } };
    return { ui };
  }

  // A dialog owns the keyboard too: every letter is form input, not a shortcut.
  if (ui.dialog) {
    if (ui.dialog.kind === "announce") return announceFormKey(ui, ev, ui.dialog);
    return confirmKey(ui, ev, ui.dialog);
  }

  const quit = ev.input === "q" || (ev.ctrl && ev.input === "c");
  if (quit) return { ui, quit: true };

  if (ev.input === ":") return { ui: { ...ui, consoleOpen: true } };

  if (ui.route === "players") {
    const count = ctx.players.length;
    if (ev.escape) return { ui: { ...ui, route: "main", playerCursor: 0 } };
    if (ev.up) return { ui: { ...ui, playerCursor: Math.max(0, ui.playerCursor - 1) } };
    if (ev.down) return { ui: { ...ui, playerCursor: Math.min(Math.max(0, count - 1), ui.playerCursor + 1) } };
    if (ev.pageUp) return { ui: { ...ui, playerCursor: Math.max(0, ui.playerCursor - Math.max(1, ctx.playerRows)) } };
    if (ev.pageDown)
      return {
        ui: { ...ui, playerCursor: Math.min(Math.max(0, count - 1), ui.playerCursor + Math.max(1, ctx.playerRows)) },
      };
    if (ev.home) return { ui: { ...ui, playerCursor: 0 } };
    if (ev.end) return { ui: { ...ui, playerCursor: Math.max(0, count - 1) } };
    if (ev.input === "r") return { ui, reload: true };
    if (ev.input === "+") return { ui, run: { args: ["bots", "add"], label: "加 1 个机器人" } };
    if (ev.input === "c") return { ui, run: { args: ["bots", "clear"], label: "清空全部机器人" } };
    if (ev.input === "-") {
      const bots = ctx.players.filter((player) => player.bot);
      if (bots.length === 0) return { ui, notice: "当前没有机器人可减（按 + 先加一个）" };
      // 实测（CoreCLI）：`kick "<userid>"` 对机器人静默且不生效，只有 CLI 的
      // `bots clear`（静默时用玩家名重试）能真的踢掉机器人。所以“减一个” =
      // 清空 + 重建 N-1 个，动作说明写在输出里。
      const remaining = bots.length - 1;
      if (remaining === 0) {
        return { ui, run: { args: ["bots", "clear"], label: "减 1 个机器人" } };
      }
      return {
        ui,
        run: {
          args: ["bots", "clear"],
          label: `减 1 个机器人（重建剩下的 ${remaining} 个）`,
          next: {
            args: ["bots", "add", "--count", String(remaining)],
            label: `重建 ${remaining} 个机器人`,
          },
        },
      };
    }
    const player = ctx.players[ui.playerCursor];
    if (player) {
      if (ev.input === "k") return { ui, run: { args: ["kick", player.userid], label: `踢出 ${player.name}` } };
      if (ev.input === "b") return { ui: { ...ui, dialog: { kind: "ban", target: player } } };
      if (ev.input === "u") return { ui: { ...ui, dialog: { kind: "unban", target: player } } };
    }
    return { ui };
  }

  if (ui.route === "banlist") {
    if (ev.escape) return { ui: { ...ui, route: "main", pageScroll: 0 } };
    if (ev.input === "r") {
      return {
        ui,
        reload: true,
        run: { args: ["banlist", "--reload"], label: "重新加载封禁名单" },
      };
    }
    if (ev.up) return { ui: scrollPage(ui, -1, ctx.banLineCount, ctx.banRows) };
    if (ev.down) return { ui: scrollPage(ui, 1, ctx.banLineCount, ctx.banRows) };
    if (ev.pageUp) return { ui: scrollPage(ui, -Math.max(1, ctx.banRows - 1), ctx.banLineCount, ctx.banRows) };
    if (ev.pageDown) return { ui: scrollPage(ui, Math.max(1, ctx.banRows - 1), ctx.banLineCount, ctx.banRows) };
    if (ev.home) return { ui: { ...ui, pageScroll: 0 } };
    if (ev.end) return { ui: { ...ui, pageScroll: Math.max(0, ctx.banLineCount - ctx.banRows) } };
    return { ui };
  }

  if (ui.route === "announce") {
    if (ev.escape) return { ui: { ...ui, route: "main", annCursor: 0, annScroll: 0 } };
    if (ev.input === "r") return { ui, reload: true };
    if (ev.input === "t") return { ui, run: { args: ["announce"], label: "广播公告" } };
    if (ev.input === "a") {
      const form: AnnounceForm = {
        field: 0,
        caret: 0,
        kind: "rotate",
        tag: "",
        text: "",
        color: "",
        sustain: "",
        fade: "",
        wait: "",
      };
      return { ui: { ...ui, dialog: { kind: "announce", form } } };
    }
    if (ev.input === "d") {
      const row = ctx.announcements[ui.annCursor];
      if (!row) return { ui, notice: "没有可删除的公告（按 r 重新读取）" };
      return {
        ui,
        run: {
          args: ["announcements", "remove", String(ui.annCursor + 1)],
          label: `删除第 ${ui.annCursor + 1} 条公告（${row.text}）`,
        },
      };
    }
    const count = ctx.announcements.length;
    const step = (delta: number): UiState => {
      const moved = moveCursor(ui.annCursor, ui.annScroll, delta, count, ctx.annRows);
      return { ...ui, annCursor: moved.cursor, annScroll: moved.scroll };
    };
    if (ev.up) return { ui: step(-1) };
    if (ev.down) return { ui: step(1) };
    if (ev.pageUp) return { ui: step(-Math.max(1, ctx.annRows - 1)) };
    if (ev.pageDown) return { ui: step(Math.max(1, ctx.annRows - 1)) };
    if (ev.home) return { ui: { ...ui, annCursor: 0, annScroll: 0 } };
    if (ev.end)
      return { ui: { ...ui, annCursor: Math.max(0, count - 1), annScroll: Math.max(0, count - ctx.annRows) } };
    return { ui };
  }

  if (ui.route === "settings") {
    const field = ctx.settingsFields[ui.edit.cursor];
    if (ev.input === "x" && ui.edit.mode === "browse" && field?.id === "playlist") return switchMode(ui, ctx);
    if (ev.input === "x" && ui.edit.mode === "browse" && field?.id === "map") return switchMap(ui, ctx);
    const outcome = settingsKey(ui.edit, ev, {
      fields: ctx.settingsFields,
      values: ctx.settingsValues,
      options: ctx.settingsOptions,
      rows: ctx.settingsRows,
    });
    return {
      ui: { ...ui, edit: outcome.state, route: outcome.exit ? "main" : "settings" },
      save: outcome.save,
      notice: outcome.notice,
    };
  }

  if (ev.escape) {
    return {
      ui: { ...ui, route: "main", pageScroll: 0, cfgDesired: {}, cfgCursor: 0, scroll: 0, follow: ui.follow },
    };
  }

  if (ui.route === "main") {
    if (ev.up) return { ui: { ...ui, sel: Math.max(0, ui.sel - 1) } };
    if (ev.down) return { ui: { ...ui, sel: Math.min(Math.max(0, ctx.versionCount - 1), ui.sel + 1) } };
    if (ev.pageUp) return { ui: scrollLog(ui, Math.max(1, ctx.logRows - 1), ctx) };
    if (ev.pageDown) return { ui: scrollLog(ui, -Math.max(1, ctx.logRows - 1), ctx) };
    if (ev.home) return { ui: { ...ui, scroll: Math.max(0, ctx.logLineCount - ctx.logRows), follow: false } };
    if (ev.end) return { ui: { ...ui, scroll: 0, follow: true } };
    if (ev.return) {
      const name = ctx.versionNames[ui.sel];
      return name ? { ui, run: { args: ["use", name], label: `切换版本到 ${name}` } } : { ui };
    }
    if (ev.input === "s") return { ui, run: { args: ["start"], label: "启动服务器" } };
    if (ev.input === "x") return { ui, run: { args: ["stop"], label: "停止服务器" } };
    if (ev.input === "R") return { ui, run: { args: ["restart"], label: "重启服务器" } };
    if (ev.input === "U") return { ui, run: { args: ["upgrade"], label: "升级版本" } };
    if (ev.input === "t") return { ui: { ...ui, route: "detail", pageScroll: 0 } };
    if (ev.input === "d") return { ui: { ...ui, route: "doctor", pageScroll: 0 } };
    if (ev.input === "e") return { ui: { ...ui, route: "config", pageScroll: 0, cfgCursor: 0, cfgDesired: {} } };
    if (ev.input === "g") return { ui: { ...ui, route: "settings", edit: initialEditState } };
    if (ev.input === "p") return { ui: { ...ui, route: "players", playerCursor: 0 } };
    if (ev.input === "n") return { ui: { ...ui, route: "announce", annCursor: 0, annScroll: 0 } };
    if (ev.input === "B") return { ui: { ...ui, route: "banlist", pageScroll: 0 } };
    if (ev.input === "l") return { ui: { ...ui, follow: !ui.follow, scroll: ui.follow ? ui.scroll : 0 } };
    return { ui };
  }

  if (ui.route === "config") {
    if (ev.input === "r") return { ui, reload: true };
    if (ev.up) return { ui: { ...ui, cfgCursor: Math.max(0, ui.cfgCursor - 1) } };
    if (ev.down) return { ui: { ...ui, cfgCursor: Math.min(Math.max(0, ctx.caps.length - 1), ui.cfgCursor + 1) } };
    if (ev.space) return { ui: applyToggle(ui, ctx) };
    if (ev.return) {
      const argv = configApplyArgv(ui, ctx);
      return { ui, run: { args: argv, label: "应用主机配置（需要管理员）" } };
    }
    return { ui };
  }

  // detail / doctor: scrollable page
  if (ev.input === "r") return { ui, reload: true };
  if (ev.up) return { ui: scrollPage(ui, -1, ctx.pageLineCount, ctx.pageRows) };
  if (ev.down) return { ui: scrollPage(ui, 1, ctx.pageLineCount, ctx.pageRows) };
  if (ev.pageUp) return { ui: scrollPage(ui, -Math.max(1, ctx.pageRows - 1), ctx.pageLineCount, ctx.pageRows) };
  if (ev.pageDown) return { ui: scrollPage(ui, Math.max(1, ctx.pageRows - 1), ctx.pageLineCount, ctx.pageRows) };
  if (ev.home) return { ui: { ...ui, pageScroll: 0 } };
  if (ev.end) return { ui: { ...ui, pageScroll: Math.max(0, ctx.pageLineCount - ctx.pageRows) } };
  return { ui };
}
