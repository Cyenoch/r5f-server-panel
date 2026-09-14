import { MANUAL_OPTION, type FieldOption, type FieldDef } from "./settings-fields";
/**
 * Pure edit state machine for the settings page.
 *
 * Three modes, the way config editors usually work:
 *   browse  move over the fields, Enter opens the editor, r restores a default
 *   input   type a value; Enter validates and saves, Esc cancels
 *   pick    choose from the field's candidates; the last entry opens the editor
 *
 * No React here: the rules are plain functions over plain state.
 */
import type { Settings } from "./state";

export type EditMode = "browse" | "input" | "pick";

export type EditState = {
  /** index into the field list */
  cursor: number;
  mode: EditMode;
  /** input buffer while mode === "input" */
  buffer: string;
  /** index into the option list while mode === "pick" */
  pick: number;
  /** validation error from the last accept attempt */
  error: string | null;
};

export type EditEvent = {
  input: string;
  up: boolean;
  down: boolean;
  pageUp: boolean;
  pageDown: boolean;
  home: boolean;
  end: boolean;
  return: boolean;
  escape: boolean;
  backspace: boolean;
  ctrl: boolean;
};

export type EditContext = {
  fields: FieldDef[];
  values: Settings;
  options: (field: FieldDef) => FieldOption[];
  /** how many option rows fit on screen */
  rows: number;
};

export type EditOutcome = {
  state: EditState;
  /** set when the value was accepted and should be persisted */
  save?: { id: FieldDef["id"]; raw: string };
  /** transient message for the status line (e.g. "已恢复默认") */
  notice?: string;
  /** Esc in browse mode: leave the page */
  exit?: boolean;
};

export const initialEditState: EditState = {
  cursor: 0,
  mode: "browse",
  buffer: "",
  pick: 0,
  error: null,
};

/** Text input: printable characters only, no control keys. */
export function isPrintable(input: string): boolean {
  if (input.length === 0) return false;
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(0, value), Math.max(0, max));
}

function currentField(state: EditState, ctx: EditContext): FieldDef | undefined {
  return ctx.fields[state.cursor];
}

/** The option list of the field being edited, with the manual entry last. */
function optionsFor(field: FieldDef | undefined, ctx: EditContext): FieldOption[] {
  return field ? ctx.options(field) : [];
}

function indexOfOption(options: FieldOption[], values: Settings, field: FieldDef): number {
  const raw = String(values[field.id]);
  const found = options.findIndex((option) => option.value === raw);
  return found >= 0 ? found : options.length - 1;
}

export function settingsKey(state: EditState, ev: EditEvent, ctx: EditContext): EditOutcome {
  const field = currentField(state, ctx);
  if (!field) return { state };

  if (state.mode === "input") {
    if (ev.escape) return { state: { ...state, mode: "browse", error: null, buffer: "" } };
    if (ev.backspace) return { state: { ...state, buffer: state.buffer.slice(0, -1), error: null } };
    if (ev.return) {
      const parsed = field.parse(state.buffer);
      if (!parsed.ok) return { state: { ...state, error: parsed.error } };
      return {
        state: { ...state, mode: "browse", error: null, buffer: "" },
        save: { id: field.id, raw: state.buffer },
      };
    }
    if (isPrintable(ev.input)) return { state: { ...state, buffer: state.buffer + ev.input, error: null } };
    return { state };
  }

  if (state.mode === "pick") {
    const options = optionsFor(field, ctx);
    if (ev.escape) return { state: { ...state, mode: "browse" } };
    if (ev.up) return { state: { ...state, pick: clamp(state.pick - 1, options.length - 1) } };
    if (ev.down) return { state: { ...state, pick: clamp(state.pick + 1, options.length - 1) } };
    if (ev.pageUp)
      return {
        state: {
          ...state,
          pick: clamp(state.pick - Math.max(1, ctx.rows - 1), options.length - 1),
        },
      };
    if (ev.pageDown)
      return {
        state: {
          ...state,
          pick: clamp(state.pick + Math.max(1, ctx.rows - 1), options.length - 1),
        },
      };
    if (ev.home) return { state: { ...state, pick: 0 } };
    if (ev.end) return { state: { ...state, pick: Math.max(0, options.length - 1) } };
    if (ev.return) {
      const option = options[state.pick];
      if (!option) return { state: { ...state, mode: "browse" } };
      if (option.value === MANUAL_OPTION) {
        return {
          state: { ...state, mode: "input", buffer: String(ctx.values[field.id]), error: null },
        };
      }
      const parsed = field.parse(option.value);
      if (!parsed.ok) return { state: { ...state, mode: "browse", error: parsed.error } };
      return {
        state: { ...state, mode: "browse", error: null },
        save: { id: field.id, raw: option.value },
      };
    }
    return { state };
  }

  // browse
  if (ev.up) return { state: { ...state, cursor: clamp(state.cursor - 1, ctx.fields.length - 1) } };
  if (ev.down) return { state: { ...state, cursor: clamp(state.cursor + 1, ctx.fields.length - 1) } };
  if (ev.home) return { state: { ...state, cursor: 0 } };
  if (ev.end) return { state: { ...state, cursor: Math.max(0, ctx.fields.length - 1) } };
  if (ev.escape) return { state: initialEditState, exit: true };
  if (ev.return) {
    const options = optionsFor(field, ctx);
    if (options.length > 0) {
      return {
        state: {
          ...state,
          mode: "pick",
          pick: indexOfOption(options, ctx.values, field),
          error: null,
        },
      };
    }
    return { state: { ...state, mode: "input", buffer: field.editText(ctx.values), error: null } };
  }
  if (ev.input === "r") {
    const raw = String(field.defaultValue);
    const parsed = field.parse(raw);
    if (!parsed.ok) return { state: { ...state, error: parsed.error } };
    return {
      state: { ...state, error: null },
      save: { id: field.id, raw },
      notice: `已恢复默认：${field.defaultText(ctx.values)}`,
    };
  }
  return { state };
}
