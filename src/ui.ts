/**
 * Terminal output helpers: colouring that degrades to plain text when not a TTY,
 * plus prompts used by the CLI's own interactive fallbacks.
 */
import * as readline from "node:readline/promises";
import stringWidth from "string-width";

// `isTTY` is `undefined` — not `false` — when the stream is not a TTY, so fall back explicitly.
const colorEnabled = (process.stdout.isTTY ?? false) && process.env.NO_COLOR === undefined;
const paint =
  (code: string) =>
  (text: string): string =>
    colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;

export const bold = paint("1");
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

let rl: readline.Interface | null = null;

function reader(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return rl;
}

export function closePrompt(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}

export function canPrompt(): boolean {
  return (process.stdin.isTTY ?? false) && (process.stdout.isTTY ?? false);
}

/** Ask for a line of text; empty input keeps the default. */
export async function ask(question: string, def = ""): Promise<string> {
  if (!canPrompt()) throw new Error("当前不是交互式终端，请改用命令行参数");
  const suffix = def.length > 0 ? ` ${dim(`[${def}]`)}` : "";
  const answer = (await reader().question(`${question}${suffix} `)).trim();
  return answer.length > 0 ? answer : def;
}

export async function confirm(question: string, def = true): Promise<boolean> {
  const hint = def ? "Y/n" : "y/N";
  const answer = (await ask(`${question} (${hint})`)).trim().toLowerCase();
  if (answer.length === 0) return def;
  return answer === "y" || answer === "yes" || answer === "是";
}

export type Choice<T> = { label: string; value: T; note?: string };

/** Numbered picker. Returns null when the operator cancels (empty or 0). */
export async function choose<T>(question: string, choices: Choice<T>[]): Promise<T | null> {
  if (choices.length === 0) return null;
  console.log("");
  choices.forEach((c, i) => {
    const note = c.note ? dim(`  ${c.note}`) : "";
    console.log(`  ${bold(String(i + 1).padStart(2))}) ${c.label}${note}`);
  });
  console.log(`   ${dim("0) 取消")}`);
  const answer = (await ask(`${question} [序号]`, "1")).trim();
  const index = Number.parseInt(answer, 10);
  if (!Number.isFinite(index) || index <= 0 || index > choices.length) return null;
  return choices[index - 1].value;
}
