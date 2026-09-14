import { readFile } from "node:fs/promises";
/**
 * 服务器轮播公告文案：`platform/datatable/chat_announcements.csv`。
 *
 * 文件由引擎/R5F 侧读取（`sv_chat_announcements.nut`），头部注释块就是 schema：
 * `kind,tag,text,color,sustain,fade,wait`。这里只做两件事：
 *
 *   parse  文件 → { preamble, rows }，preamble（注释块 + 表头行 + 类型行）原样保留
 *   render { preamble, rows } → 文件，preamble 逐字节原样，数据行交给 csv-stringify
 *
 * 手搓 CSV 会在引号单元格上出错，所以解析/生成都用维护中的 `csv-parse` /
 * `csv-stringify`。改完的文案要 `changelevel`（或重启 dedi）才生效 —— 这是文件头
 * 自己写的，界面必须一并告知。
 */
import { join } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { stringify as stringifyCsv } from "csv-stringify/sync";

export type AnnouncementKind = "rotate" | "welcome";

export type Announcement = {
  kind: AnnouncementKind;
  tag: string;
  text: string;
  color: string;
  sustain: string;
  fade: string;
  wait: string;
};

export type AnnouncementsFile = { path: string; preamble: string; rows: Announcement[] };

/** 版本目录内的相对路径（跨平台拼接交给 `announcementsPath`）。 */
export const ANNOUNCEMENTS_RELATIVE = "platform/datatable/chat_announcements.csv";

export function announcementsPath(versionDir: string): string {
  return join(versionDir, ANNOUNCEMENTS_RELATIVE);
}

/** 文案上限（文件头 schema 原文：Max 64 characters）。 */
const MAX_TEXT_CHARS = 64;

const KINDS: Record<string, true> = { rotate: true, welcome: true };

const COLORS: Record<string, true> = {
  "": true,
  white: true,
  red: true,
  gold: true,
  green: true,
  cyan: true,
  rainbow: true,
  "255 80 80": true,
};

/** 类型行的合法单元格（`string,string,string,string,float,float,float`）。 */
const TYPE_CELLS: Record<string, true> = { string: true, float: true, int: true, bool: true };

/**
 * 文件缺失/为空时的 schema 头，与构建自带文件的头部逐字一致。
 * 这样"新建公告文件"产出的仍是引擎认得的格式。
 */
const DEFAULT_PREAMBLE =
  [
    "# Chat lines. Edit this file, then changelevel (or restart the dedi).",
    "#",
    "# kind:    rotate  = looping server messages",
    "#          welcome = shown once after a player joins",
    "# tag:     cyan prefix, e.g. [Flowstate]. Blank = none.",
    "# text:    the line. Max 64 characters. Quote the cell if it has a comma.",
    "# color:   blank/white, red, gold, green, cyan, rainbow, or 255 80 80",
    "# sustain: seconds fully visible. Blank = 8",
    "# fade:    seconds to fade out. Blank = 2",
    "# wait:    rotate  = seconds until the next rotate line. Blank = 60",
    "#          welcome = seconds after join before it shows. Blank = 10",
    "#",
    "kind,tag,text,color,sustain,fade,wait",
    "string,string,string,string,float,float,float",
  ].join("\n") + "\n";

/** 单行按 CSV 规则切开（表头/类型行可能带引号，不能按逗号硬切）。 */
function cellsOf(line: string): string[] {
  try {
    const records = parseCsv(line, { relax_column_count: true });
    const record: string[] | undefined = records[0];
    return record ?? [];
  } catch {
    return [];
  }
}

function isHeaderLine(line: string): boolean {
  return (cellsOf(line)[0] ?? "").trim().toLowerCase() === "kind";
}

function isTypeLine(line: string): boolean {
  const cells = cellsOf(line);
  return cells.length > 0 && cells.every((cellValue) => TYPE_CELLS[cellValue.trim().toLowerCase()]);
}

/** 空/未识别的 kind 按 `rotate` 处理（类型只允许两种）。 */
function asKind(value: string | undefined): AnnouncementKind {
  return (value ?? "").trim().toLowerCase() === "welcome" ? "welcome" : "rotate";
}

/** 数据行单元格：缺失的列补空串，保持 `Announcement` 的字段数固定。 */
function cell(value: string | undefined): string {
  return value ?? "";
}

function rowFromCells(cells: readonly string[]): Announcement {
  return {
    kind: asKind(cells[0]),
    tag: cell(cells[1]),
    text: cell(cells[2]),
    color: cell(cells[3]),
    sustain: cell(cells[4]),
    fade: cell(cells[5]),
    wait: cell(cells[6]),
  };
}

/**
 * preamble = 开头连续的注释块 + 表头行 + 类型行（逐字节原样，含行尾风格）；
 * 其余即数据行。
 */
export function parseAnnouncements(text: string, path = ""): AnnouncementsFile {
  if (text === "") return { path, preamble: "", rows: [] };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  const endsWithEol = lines.length > 0 && lines[lines.length - 1] === "";
  if (endsWithEol) lines.pop();

  let index = 0;
  while (index < lines.length && (lines[index].trim() === "" || lines[index].trimStart().startsWith("#"))) {
    index++;
  }
  if (index < lines.length && isHeaderLine(lines[index])) index++;
  if (index < lines.length && isTypeLine(lines[index])) index++;

  const dataLines = lines.slice(index);
  const data = dataLines.length > 0 ? dataLines.join(eol) + (endsWithEol ? eol : "") : "";
  const preamble =
    index === 0 ? "" : lines.slice(0, index).join(eol) + (dataLines.length > 0 || endsWithEol ? eol : "");

  let parsed: string[][] = [];
  try {
    parsed = parseCsv(data, {
      comment: "#",
      skip_empty_lines: true,
      relax_column_count: true,
    });
  } catch {
    parsed = [];
  }
  return { path, preamble, rows: parsed.map(rowFromCells) };
}

/** preamble 逐字节原样 + 数据行由 csv-stringify 生成（含逗号的字段自动加引号）。 */
export function renderAnnouncements(file: AnnouncementsFile): string {
  const eol = file.preamble.includes("\r\n") ? "\r\n" : "\n";
  const rows = file.rows.map((row) => [row.kind, row.tag, row.text, row.color, row.sustain, row.fade, row.wait]);
  return file.preamble + stringifyCsv(rows, { record_delimiter: eol });
}

/** 校验结果是一组中文原因；空数组 = 可写入。 */
export function validateAnnouncement(row: Announcement): string[] {
  const errors: string[] = [];
  if (!KINDS[row.kind]) errors.push(`kind 只能是 rotate 或 welcome（当前：${row.kind}）`);

  const text = row.text.trim();
  const length = Array.from(text).length;
  if (length === 0) errors.push("公告文案不能为空");
  else if (length > MAX_TEXT_CHARS) errors.push(`公告文案最多 ${MAX_TEXT_CHARS} 个字符（当前 ${length} 个）`);

  if (!COLORS[row.color.trim()]) {
    errors.push(`color 只能是 空/white/red/gold/green/cyan/rainbow/255 80 80（当前：${row.color}）`);
  }

  const numbers: Array<[string, string]> = [
    ["sustain", row.sustain],
    ["fade", row.fade],
    ["wait", row.wait],
  ];
  for (const [label, value] of numbers) {
    const raw = value.trim();
    if (raw !== "" && !Number.isFinite(Number(raw))) errors.push(`${label} 必须是数字或留空（当前：${value}）`);
  }
  return errors;
}

/** 读版本目录里的真实文件；缺失或为空时给出可写的 schema 骨架，不抛错。 */
export async function collectAnnouncements(versionDir: string): Promise<AnnouncementsFile> {
  const path = announcementsPath(versionDir);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { path, preamble: DEFAULT_PREAMBLE, rows: [] };
  }
  const file = parseAnnouncements(text, path);
  return text.trim() === "" ? { ...file, preamble: DEFAULT_PREAMBLE } : file;
}
