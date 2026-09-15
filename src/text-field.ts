/**
 * One-line text field with an insertion caret.
 *
 * The caret is a code-unit index kept on code-point boundaries, so ←/→ and 退格
 * never split a surrogate pair（中文与 emoji 都按整字走）。面板里所有文本输入共用
 * 这一套规则：设置值、控制台命令行、公告表单的行内文字。
 *
 * Kept free of React and of the terminal: plain functions over plain state.
 */

export type TextField = { text: string; caret: number };

/** A field holding `text` with the caret after it (编辑器打开就接着往后敲). */
export function textField(text: string): TextField {
  return { text, caret: text.length };
}

/** Text before/after the caret; the caret is clamped back onto a code-point boundary. */
export function splitAtCaret(field: TextField): { before: string; after: string } {
  const caret = Math.min(Math.max(0, field.caret), field.text.length);
  const low = field.text.charCodeAt(caret);
  const safe = low >= 0xdc00 && low <= 0xdfff ? caret - 1 : caret;
  return { before: field.text.slice(0, safe), after: field.text.slice(safe) };
}

/** Insert at the caret: typing and pasting take the same path. */
export function insertText(field: TextField, input: string): TextField {
  const { before, after } = splitAtCaret(field);
  return { text: `${before}${input}${after}`, caret: before.length + input.length };
}

/** Backspace: drop the code point before the caret (a no-op at the left end). */
export function deleteBefore(field: TextField): TextField {
  const { before, after } = splitAtCaret(field);
  if (before.length === 0) return field;
  const cut = stepCaret(field.text, before.length, -1);
  return { text: `${field.text.slice(0, cut)}${after}`, caret: cut };
}

/** Delete: drop the code point at the caret (a no-op at the right end). */
export function deleteAtCaret(field: TextField): TextField {
  const { before, after } = splitAtCaret(field);
  if (after.length === 0) return field;
  const cut = stepCaret(field.text, before.length, 1);
  return { text: `${field.text.slice(0, before.length)}${after.slice(cut - before.length)}`, caret: before.length };
}

/** ←/→: move `step` code points from the caret, clamped at both ends. */
export function moveCaret(field: TextField, step: number): TextField {
  const { before } = splitAtCaret(field);
  return { ...field, caret: stepCaret(field.text, before.length, step) };
}

/** Home / End: park the caret on one end of the field. */
export function caretToEdge(field: TextField, edge: "start" | "end"): TextField {
  return { ...field, caret: edge === "start" ? 0 : field.text.length };
}

/**
 * The caret `step` code points away from `index`, clamped to the ends of `text`.
 * Surrogate pairs（辅助平面字符的两个半区）count as one code point, so the caret
 * never lands between the halves.
 */
function stepCaret(text: string, index: number, step: number): number {
  let caret = Math.min(Math.max(0, index), text.length);
  for (let moved = 0; moved < Math.abs(step); moved += 1) {
    if (step < 0) {
      if (caret <= 0) break;
      const low = text.charCodeAt(caret - 1);
      caret -= low >= 0xdc00 && low <= 0xdfff && caret >= 2 ? 2 : 1;
      continue;
    }
    if (caret >= text.length) break;
    const high = text.charCodeAt(caret);
    caret += high >= 0xd800 && high <= 0xdbff && caret + 2 <= text.length ? 2 : 1;
  }
  return caret;
}
