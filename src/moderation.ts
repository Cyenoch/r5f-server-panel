/**
 * 临时封禁记录（本工具侧）。
 *
 * 引擎的 `ban` 只有目标一个参数（实测 `help ban` → `Bans a client from the server by
 * user name ( ban <userId> )`），**没有**时长、没有原因、没有到期 —— 封了就是永久，
 * 只能 `unban` 恢复。所以"封 30 分钟"这件事只能由本工具兑现：
 *
 *   1. 立即发 `ban "<target>"`（真正封禁由引擎执行）；
 *   2. 在本机记一条记录（原因、到期、是谁被封），到期由日志守护（`__logd`）发
 *      `unban "<id64>"`。
 *
 * 记录是**本机**的：引擎不保存原因与到期，界面上必须如实这么说。守护不在时（实例已停、
 * 机器重启）到期不会执行 —— `banlist` 会把它标成"到期未解封"，提示手动 `unban`。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ModerationState = "pending" | "unbanned";

export type ModerationEntry = {
  id: string;
  /** 操作者输入的目标（userid 或 id64），原样留着好对账。 */
  target: string;
  /** 解封要用的 id64（引擎 `unban "<userId>"`）。 */
  id64: string;
  /** 封禁时该玩家的名字（面板/封禁名单显示用）。 */
  name: string;
  reason: string;
  /** 0 = 永久（只记原因，不自动解封） */
  minutes: number;
  /** epoch 毫秒；0 = 永久 */
  expiresAt: number;
  /** epoch 毫秒 */
  issuedAt: number;
  state: ModerationState;
  unbannedAt?: number;
};

export type ModerationFile = { version: 1; entries: ModerationEntry[] };

export const MODERATION_FILE = "moderation.json";

export function moderationPath(root: string): string {
  return join(root, MODERATION_FILE);
}

const emptyFile = (): ModerationFile => ({ version: 1, entries: [] });

function readEntry(raw: unknown): ModerationEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  const id64 = typeof o.id64 === "string" ? o.id64 : "";
  const issuedAt = typeof o.issuedAt === "number" ? o.issuedAt : 0;
  const expiresAt = typeof o.expiresAt === "number" ? o.expiresAt : 0;
  if (id.length === 0 || id64.length === 0 || issuedAt <= 0) return null;
  const minutes =
    typeof o.minutes === "number" ? o.minutes : expiresAt > issuedAt ? Math.round((expiresAt - issuedAt) / 60_000) : 0;
  if (minutes > 0 && expiresAt <= issuedAt) return null;
  return {
    id,
    target: typeof o.target === "string" ? o.target : id64,
    id64,
    name: typeof o.name === "string" ? o.name : "",
    reason: typeof o.reason === "string" ? o.reason : "",
    minutes,
    issuedAt,
    expiresAt: minutes > 0 ? expiresAt : 0,
    state: o.state === "unbanned" ? "unbanned" : "pending",
    unbannedAt: typeof o.unbannedAt === "number" ? o.unbannedAt : undefined,
  };
}

/** 读记录文件；不存在或坏掉都只当"没有记录"（坏文件会被下一次写入覆盖）。 */
export function loadModeration(root: string): ModerationFile {
  const path = moderationPath(root);
  if (!existsSync(path)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return {
      version: 1,
      entries: rawEntries.map(readEntry).filter((entry): entry is ModerationEntry => entry !== null),
    };
  } catch {
    return emptyFile();
  }
}

/** 临时文件 + 改名（与 `saveState` 同一套），守护与 CLI 同时写也不会留下半截文件。 */
export function saveModeration(root: string, file: ModerationFile): void {
  const path = moderationPath(root);
  mkdirSync(root, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
  renameSync(tmp, path);
}

export function addRecord(root: string, entry: ModerationEntry): ModerationFile {
  const file = loadModeration(root);
  file.entries.unshift(entry);
  // 只留最近 200 条：这是操作台账，不是审计库。
  file.entries = file.entries.slice(0, 200);
  saveModeration(root, file);
  return file;
}

/** 到期且还没解封的记录（守护每次心跳都读一遍）；永久记录（minutes = 0）永不入选。 */
export function dueEntries(file: ModerationFile, now: number): ModerationEntry[] {
  return file.entries.filter((entry) => entry.state === "pending" && entry.minutes > 0 && entry.expiresAt <= now);
}

/** 标记已发过解封；返回是否真的改动了（避免没必要的写盘）。 */
export function markUnbanned(root: string, id: string, at: number): boolean {
  return markUnbannedBy(root, (entry) => entry.id === id, at);
}

/** 手工 `unban <target>` 之后把对应的本地记录也标掉（target 可以是 id64 或当初输入的 userid）。 */
export function markUnbannedByTarget(root: string, target: string, at: number): number {
  const wanted = target.trim();
  let changed = 0;
  const file = loadModeration(root);
  for (const entry of file.entries) {
    if (entry.state === "unbanned") continue;
    if (entry.id64 !== wanted && entry.target !== wanted) continue;
    entry.state = "unbanned";
    entry.unbannedAt = at;
    changed += 1;
  }
  if (changed > 0) saveModeration(root, file);
  return changed;
}

function markUnbannedBy(root: string, match: (entry: ModerationEntry) => boolean, at: number): boolean {
  const file = loadModeration(root);
  const entry = file.entries.find((candidate) => match(candidate));
  if (!entry || entry.state === "unbanned") return false;
  entry.state = "unbanned";
  entry.unbannedAt = at;
  saveModeration(root, file);
  return true;
}

/** 面板/CLI 的到期文案：本地时间 + 剩余时长。 */
export function describeExpiry(entry: ModerationEntry, now: number): string {
  if (entry.state === "unbanned")
    return `已于 ${entry.unbannedAt ? new Date(entry.unbannedAt).toLocaleString() : "?"} 解除`;
  if (entry.minutes === 0) return "永久（本机只记原因，不会自动解封）";
  const at = new Date(entry.expiresAt);
  const remaining = entry.expiresAt - now;
  if (remaining <= 0) return `已到期（${at.toLocaleString()}），等待守护发解封`;
  const minutes = Math.ceil(remaining / 60_000);
  return `${at.toLocaleString()}（约 ${minutes} 分钟后）`;
}
