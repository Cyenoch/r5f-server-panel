/**
 * 终端输出辅助：不是 TTY 时颜色自动退化成纯文本。
 * worker 的 setup / autostart 输出会原样进面板的「操作记录」，所以取色要保守。
 */

import stringWidth from "string-width";
// `isTTY` is `undefined` — not `false` — when the stream is not a TTY, so fall back explicitly.
const colorEnabled = (process.stdout.isTTY ?? false) && process.env.NO_COLOR === undefined;
const paint =
  (code: string) =>
  (text: string): string =>
    colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;
export const dim = paint("2");
export const red = paint("31");
export const green = paint("32");
export const yellow = paint("33");
export const cyan = paint("36");

/** Pad to a display width (CJK glyphs take two cells, code units would misalign). */
export function padEndWidth(text: string, width: number): string {
  const pad = width - stringWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

export function header(title: string): void {
  const line = "-".repeat(Math.max(8, stringWidth(title) + 4));
  console.log("");
  console.log(cyan(line));
  console.log(cyan(`  ${title}`));
  console.log(cyan(line));
}

export function kv(label: string, value: string, indent = 2): void {
  console.log(`${" ".repeat(indent)}${dim(padEndWidth(label, 16))}${value}`);
}
