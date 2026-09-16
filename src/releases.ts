/**
 * Official release discovery and installation (`r5f-dedi-X.Y.Z.zip`).
 *
 * Two operations, both against the publisher's own endpoints only:
 *
 *   checkRelease()    What is published right now? A HEAD to
 *                     `https://r5flowstate.org/dedi` (which 302s to
 *                     `<cdn>/content/server/<version>/r5f-dedi-<version>.zip`)
 *                     gives the file name and size; nothing is guessed, and an
 *                     unreadable name is an error rather than a fallback guess.
 *   installRelease()  Stream that ZIP to disk (never into memory), extract it
 *                     with the platform's own tooling, verify the server triad,
 *                     then rename the staged directory into `ROOT` in one step.
 *
 * Why the version comes out of the file name: the publisher ships no manifest and
 * no checksum — there is nothing to verify the bytes against. So the panel takes
 * the file name as the version statement, parses it strictly
 * (`r5f-dedi-X.Y.Z.zip`) and compares the numbers, never the strings
 * (`1.0.9` < `1.0.10`, while `"1.0.9" > "1.0.10"`). The UI says outright that
 * discovery is file-name based and that no checksum exists; inventing a
 * "verified" badge for an archive nobody signed would be worse than saying so.
 *
 * Guarantees, all enforced here rather than trusted to the caller:
 *   - HTTPS on an official origin, for the entry URL *and* the redirect target;
 *   - a published file name must be a plain `*.zip` segment — no separators, no
 *     `..`, no drive letters — so it can never escape the install root;
 *   - an existing `r5f-dedi-X.Y.Z` directory is a refusal, not a merge: this
 *     module only ever adds versions, and never edits or deletes one;
 *   - a half-finished install is never discoverable: download and extraction
 *     happen in `ROOT/.r5f-install/<job>/`, which has no triad at its top and
 *     therefore is not a candidate build, and only a complete, triad-verified
 *     tree is renamed to `ROOT/<name>`;
 *   - one install at a time (in-process lock);
 *   - `state` is not touched at all — installing never switches `current` and
 *     never disturbs a running instance. A new version becomes usable when the
 *     operator picks it (or points an instance at it), not when it lands.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from "node:fs";
import { basename, join } from "node:path";
import { ROOT } from "./state";
import { type VersionInfo, discoverVersions } from "./versions";

/** The publisher's stable entry point; the CDN location behind it may change. */
export const RELEASE_ENDPOINT = "https://r5flowstate.org/dedi";

/** Official domain; any subdomain of it is accepted for redirect targets. */
const OFFICIAL_DOMAIN = "r5flowstate.org";

/** Staging root under `ROOT`. Holds no triad at its top level → never a build. */
const STAGING = ".r5f-install";

const TRIAD = ["r5apex_ds.exe", "server.dll", "loader.dll"] as const;

const HEADERS = {
  "user-agent": "r5-server-panel",
  accept: "application/zip,application/octet-stream;q=0.9,*/*;q=0.8",
};

const PROBE_TIMEOUT_MS = 20_000;
/** Progress callbacks are for a UI; do not fire one per 16 KiB chunk. */
const PROGRESS_INTERVAL_MS = 120;
/** Extraction progress is a directory walk — once a second is plenty. */
const EXTRACT_POLL_MS = 1_000;
/** Stale staging directories older than this are crash leftovers. */
const STALE_JOB_MS = 24 * 60 * 60 * 1000;

const RELEASE_FILE = /^r5f-dedi-(\d+)\.(\d+)\.(\d+)\.zip$/i;
const EMBEDDED_VERSION = /^r5f-dedi-(\d+)\.(\d+)\.(\d+)/i;

export type ReleaseInfo = {
  /** `1.0.13`, parsed from the published file name. */
  version: string;
  /** `r5f-dedi-1.0.13` — the directory name this installs as. */
  name: string;
  /** `r5f-dedi-1.0.13.zip`, as published. */
  filename: string;
  /** Final HTTPS URL after redirects, on an official origin. */
  url: string;
  /** `Content-Length` (or the total in `Content-Range`), null when the CDN omits it. */
  sizeBytes: number | null;
  /** ISO timestamp of the check that produced this. */
  checkedAt: string;
};

export type ReleaseIdentity = Pick<ReleaseInfo, "name" | "version">;

export type InstallPhase = "downloading" | "extracting" | "complete";

export type InstallProgress = {
  phase: InstallPhase;
  /**
   * Bytes written to disk while `downloading`, bytes already unpacked while
   * `extracting`, and the archive size once `complete`.
   */
  receivedBytes: number;
  /** `null` when neither the CDN nor the archive states a total. */
  totalBytes: number | null;
};

export type InstallProgressHandler = (progress: InstallProgress) => void;

/**
 * Why an install failed, for the UI to phrase. The message is already
 * operator-readable; the code exists so a page can pick a tone and decide
 * whether retrying is sensible.
 */
export type ReleaseErrorCode =
  /** Could not reach the endpoint, or it answered with an HTTP error. */
  | "network"
  /** A URL was not HTTPS or not on the official domain. */
  | "origin"
  /** The published file name is missing, unreadable, or not a release ZIP. */
  | "filename"
  /** That version directory already exists. */
  | "exists"
  /** Another install is running in this process. */
  | "busy"
  /** The operator cancelled (or the signal was already aborted). */
  | "cancelled"
  /** Fewer bytes arrived than the CDN announced. */
  | "incomplete"
  /** Not enough free space on the install volume. */
  | "space"
  /** The ZIP is unreadable, unsafe, or failed to extract. */
  | "archive"
  /** Extracted content does not look like a server version (triad missing/mismatched). */
  | "triad"
  /** Anything else that went wrong while placing the files. */
  | "install";

export class ReleaseError extends Error {
  readonly code: ReleaseErrorCode;

  constructor(code: ReleaseErrorCode, detail: string, options?: { cause?: unknown }) {
    super(detail, options);
    this.name = "ReleaseError";
    this.code = code;
  }
}

// ------------------------------------------------------------------ 发现

export type ReleaseDelta = "newer" | "same" | "older" | "unknown";

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function points(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when `a` is older, positive when newer, 0 when equal. */
function comparePoints(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Numeric comparison of the published release against the best installed version.
 * `unknown` means one side carries no comparable numbers (a hand-made directory
 * name like `r5f-dedi-nightly`), and the UI must ask rather than claim.
 */
export function releaseDelta(release: ReleaseInfo, installed: VersionInfo[]): ReleaseDelta {
  const published = points(release.version);
  if (published === null) return "unknown";
  let best: [number, number, number] | null = null;
  for (const version of installed) {
    if (version.version === null) continue;
    if (best === null || comparePoints(version.version, best) > 0) best = version.version;
  }
  if (best === null) return "newer";
  const diff = comparePoints(published, best);
  return diff > 0 ? "newer" : diff === 0 ? "same" : "older";
}

/** The installed directory that *is* this release: same name first, else same numbers. */
export function findInstalled(release: ReleaseInfo, installed: VersionInfo[]): VersionInfo | null {
  const exact = installed.find((version) => version.name === release.name);
  if (exact) return exact;
  const published = points(release.version);
  if (published === null) return null;
  return installed.find((v) => v.version !== null && comparePoints(v.version, published) === 0) ?? null;
}

/** `r5f-dedi-1.0.13.zip` → `1.0.13`. Strict by design: anything else is refused. */
function parseReleaseFilename(filename: string): { version: string; name: string } | null {
  const m = RELEASE_FILE.exec(filename);
  if (m === null) return null;
  const version = [m[1], m[2], m[3]].map((part) => String(Number(part))).join(".");
  return { version, name: `r5f-dedi-${version}` };
}

/** One plain path segment: no separators, no traversal, nothing to resolve. */
function safeFilename(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 120) return null;
  if (value === "." || value === ".." || value !== basename(value)) return null;
  if (!/^[A-Za-z0-9._+-]+$/.test(value)) return null;
  return value;
}

function filenameFromDisposition(header: string | null): string | null {
  if (header === null) return null;
  const extended = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (extended !== null) {
    const value = extended[1].trim().replace(/^"(.*)"$/, "$1");
    // RFC 5987: `charset'language'percent-encoded-name`.
    const stripped = /^[^']*'[^']*'(.*)$/.exec(value);
    const name = stripped === null ? value : stripped[1];
    try {
      return decodeURIComponent(name);
    } catch {
      return name;
    }
  }
  const plain = /filename\s*=\s*([^;]+)/i.exec(header);
  if (plain === null) return null;
  return plain[1].trim().replace(/^"(.*)"$/, "$1");
}

function filenameFromUrl(url: URL): string | null {
  const segment = url.pathname.split("/").findLast(Boolean);
  if (segment === undefined) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function officialUrl(raw: string, what: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ReleaseError("origin", `${what}不是合法地址：${raw.length > 0 ? raw : "(空)"}`);
  }
  if (parsed.protocol !== "https:") {
    throw new ReleaseError("origin", `${what}不是 HTTPS（${parsed.protocol}//），拒绝继续`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== OFFICIAL_DOMAIN && !host.endsWith(`.${OFFICIAL_DOMAIN}`)) {
    throw new ReleaseError("origin", `${what}指向非官方域名 ${host}，拒绝继续`);
  }
  return parsed;
}

/** Total size from `Content-Range` (range reply) or `Content-Length` (HEAD reply). */
function responseSize(res: Response): number | null {
  const range = res.headers.get("content-range");
  if (range !== null) {
    const total = /\/(\d+)\s*$/.exec(range);
    if (total !== null) {
      const n = Number(total[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  const length = res.headers.get("content-length");
  if (length !== null) {
    const n = Number(length);
    // A 206 for `bytes=0-0` reports a length of 1: that is not the archive size.
    if (Number.isFinite(n) && n > 1) return n;
  }
  return null;
}

/**
 * Ask the CDN about a URL without transferring it. HEAD first; some CDNs answer
 * HEAD with 403/405, in which case a one-byte range GET returns the same headers
 * and the body is dropped.
 */
async function probe(entry: URL): Promise<Response> {
  let head: Response;
  try {
    head = await fetch(entry, {
      method: "HEAD",
      redirect: "follow",
      headers: HEADERS,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new ReleaseError("network", `连不上官方地址：${message(cause)}`, { cause });
  }
  if (head.ok) return head;
  if (head.status !== 403 && head.status !== 405 && head.status !== 501) return head;
  let ranged: Response;
  try {
    ranged = await fetch(entry, {
      redirect: "follow",
      headers: { ...HEADERS, range: "bytes=0-0" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new ReleaseError("network", `连不上官方地址：${message(cause)}`, { cause });
  }
  await ranged.body?.cancel().catch(() => {});
  return ranged;
}

/**
 * What the publisher currently offers. Throws rather than returning a guess:
 * without a readable `r5f-dedi-X.Y.Z.zip` name there is no version to compare,
 * let alone install.
 */
export async function checkRelease(): Promise<ReleaseInfo> {
  const entry = officialUrl(RELEASE_ENDPOINT, "官方版本地址");
  const res = await probe(entry);
  if (!res.ok) {
    throw new ReleaseError(
      "network",
      `官方地址返回 HTTP ${res.status}${res.statusText.length > 0 ? ` ${res.statusText}` : ""}`,
    );
  }
  const final = officialUrl(res.url.length > 0 ? res.url : entry.href, "跳转后的下载地址");
  const type = res.headers.get("content-type") ?? "";
  if (type.toLowerCase().startsWith("text/html")) {
    throw new ReleaseError("filename", `官方地址回的是网页而不是安装包（Content-Type: ${type}）`);
  }
  const filename =
    safeFilename(filenameFromDisposition(res.headers.get("content-disposition"))) ??
    safeFilename(filenameFromUrl(final));
  if (filename === null) {
    throw new ReleaseError("filename", "官方地址没有给出可识别的 ZIP 文件名，拒绝猜测该装什么");
  }
  const parsed = parseReleaseFilename(filename);
  if (parsed === null) {
    throw new ReleaseError(
      "filename",
      `官方 ZIP 的文件名不是 r5f-dedi-版本号.zip 的形状（${filename}），拒绝按猜出来的版本号安装`,
    );
  }
  return {
    version: parsed.version,
    name: parsed.name,
    filename,
    url: final.href,
    sizeBytes: responseSize(res),
    checkedAt: new Date().toISOString(),
  };
}

// ------------------------------------------------------------------ 安装

/** Name of the version being installed right now, or null. One at a time. */
let installing: string | null = null;

export function isInstalling(): boolean {
  return installing !== null;
}

type Job = {
  dir: string;
  report: (phase: InstallPhase, received: number, total: number | null, force?: boolean) => void;
};

/** Throttled progress emitter: phase changes and the last byte always get through. */
function reporter(onProgress?: InstallProgressHandler): Job["report"] {
  let last = 0;
  let lastPhase: InstallPhase | null = null;
  return (phase, received, total, force = false) => {
    if (onProgress === undefined) return;
    const now = Date.now();
    if (!force && phase === lastPhase && now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    lastPhase = phase;
    onProgress({ phase, receivedBytes: received, totalBytes: total });
  };
}

function assertIdentity(identity: ReleaseIdentity): void {
  const parsed = parseReleaseFilename(`${identity.name}.zip`);
  if (parsed === null || parsed.name !== identity.name || parsed.version !== identity.version) {
    throw new ReleaseError("filename", `版本标识不合法（${identity.name} / ${identity.version}），拒绝用它命名目录`);
  }
}

function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name))
      .toSorted();
  } catch {
    return [];
  }
}

function missingTriad(dir: string): string[] {
  return TRIAD.filter((file) => {
    try {
      statSync(join(dir, file));
      return false;
    } catch {
      return true;
    }
  });
}

/**
 * Where the version directory actually is inside the extraction. Archives ship
 * either the version directory itself or the executable files at the top level;
 * a container directory (`r5f-dedi-1.0.14/win64/…`) is not part of the published
 * layout but is cheap to tolerate, so one extra level is searched.
 */
function findServerRoot(extract: string): string | null {
  if (missingTriad(extract).length === 0) return extract;
  const children = subdirectories(extract);
  for (const child of children) {
    if (missingTriad(child).length === 0) return child;
  }
  for (const child of children) {
    for (const grandchild of subdirectories(child)) {
      if (missingTriad(grandchild).length === 0) return grandchild;
    }
  }
  return null;
}

/** Bytes under `dir`; used only to show extraction progress. */
function treeBytes(dir: string): number {
  let bytes = 0;
  try {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        bytes += statSync(join(entry.parentPath ?? dir, entry.name)).size;
      } catch {
        /* vanished mid-walk: skip */
      }
    }
  } catch {
    /* unreadable tree: report what we have */
  }
  return bytes;
}

function freeBytes(path: string): number | null {
  try {
    const stats = statfsSync(path);
    const available = stats.bavail * stats.bsize;
    return Number.isFinite(available) ? available : null;
  } catch {
    return null;
  }
}

function requireSpace(dir: string, neededBytes: number): void {
  const available = freeBytes(dir);
  if (available === null || neededBytes <= 0) return;
  if (available < neededBytes) {
    throw new ReleaseError(
      "space",
      `安装盘剩余空间不足：还需要约 ${(neededBytes / 1024 ** 3).toFixed(1)} GB，当前只剩 ${(available / 1024 ** 3).toFixed(1)} GB`,
    );
  }
}

type RunResult = { code: number; out: string; err: string; missing: boolean };

/** Run an external tool, polling a callback while it works and killing it on abort. */
async function run(cmd: string[], opts: { signal?: AbortSignal; onTick?: () => void } = {}): Promise<RunResult> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (cause) {
    // Missing binary: the caller walks its fallback ladder.
    return { code: -1, out: "", err: message(cause), missing: true };
  }
  const out = new Response(proc.stdout).text();
  const err = new Response(proc.stderr).text();
  const onAbort = (): void => proc.kill();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = opts.onTick === undefined ? undefined : setInterval(opts.onTick, EXTRACT_POLL_MS);
  try {
    const code = await proc.exited;
    return { code, out: (await out).trim(), err: (await err).trim(), missing: false };
  } finally {
    clearInterval(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

type ArchiveEntry = { name: string; bytes: number; symlink: boolean };
type ArchiveListing = { entries: ArchiveEntry[]; totalBytes: number };

const ZIPINFO_ENTRY = /^([-dl?])\S{9}\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/;
const ZIPINFO_TOTAL = /(\d[\d,._ ]*) bytes uncompressed/;

/** `zipinfo`-style listing: name, uncompressed size and symlink flag per entry. */
async function listArchiveUnix(zip: string): Promise<ArchiveListing | null> {
  const result = await run(["unzip", "-Z", zip]);
  if (result.code !== 0) return null;
  const entries: ArchiveEntry[] = [];
  for (const line of result.out.split("\n")) {
    const m = ZIPINFO_ENTRY.exec(line);
    if (m === null) continue;
    const bytes = Number(m[4]);
    if (!Number.isFinite(bytes)) continue;
    entries.push({ name: m[9], bytes, symlink: m[1] === "l" });
  }
  if (entries.length === 0) return null;
  const total = ZIPINFO_TOTAL.exec(result.out);
  const declared = total === null ? 0 : Number(total[1].replace(/\D/g, ""));
  return {
    entries,
    totalBytes: declared > 0 ? declared : entries.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

/** Same listing through .NET, which is all a stock Windows box has before extraction. */
async function listArchiveWindows(zip: string): Promise<ArchiveListing | null> {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$z=[System.IO.Compression.ZipFile]::OpenRead(${psQuote(zip)})`,
    "try {",
    "  foreach ($e in $z.Entries) {",
    "    $mode = ($e.ExternalAttributes -shr 16) -band 0xF000",
    '    "{0}`t{1}`t{2}" -f $e.Length, $mode, $e.FullName',
    "  }",
    "} finally { $z.Dispose() }",
  ].join("\n");
  const result = await run(psCommand(script));
  if (result.code !== 0) return null;
  const entries: ArchiveEntry[] = [];
  for (const line of result.out.split("\n")) {
    const first = line.indexOf("\t");
    const second = first < 0 ? -1 : line.indexOf("\t", first + 1);
    if (second < 0) continue;
    const bytes = Number(line.slice(0, first));
    const mode = Number(line.slice(first + 1, second));
    if (!Number.isFinite(bytes)) continue;
    entries.push({ name: line.slice(second + 1), bytes, symlink: mode === 0xa000 });
  }
  if (entries.length === 0) return null;
  return { entries, totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
}

/** PowerShell with the script base64-encoded, so paths never need quoting rules. */
function psCommand(script: string): string[] {
  return [
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Reject an archive we should not unwrap. Extraction happens into a fresh
 * staging directory, so `..` entries and absolute paths are the two ways a ZIP
 * could write outside it; links are rejected because server content has no
 * reason to carry any and a link is the classic second step of that trick.
 */
function entryProblem(entry: ArchiveEntry): string | null {
  const name = entry.name;
  if (name.length === 0) return "压缩包里有一条没有文件名的记录";
  if (name.includes("\u0000")) return `压缩包里有带 NUL 的文件名：${JSON.stringify(name)}`;
  if (name.startsWith("/") || name.startsWith("\\")) return `压缩包里有绝对路径：${name}`;
  if (/^[A-Za-z]:/.test(name)) return `压缩包里有盘符路径：${name}`;
  if (name.split(/[\\/]+/).includes("..")) return `压缩包里有跳出目标目录的路径：${name}`;
  if (entry.symlink) return `压缩包里有一个符号链接（${name}）；服务端内容不带链接，拒绝解压`;
  return null;
}

function lastLine(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.length === 0 ? "(没有输出)" : lines[lines.length - 1].trim();
}

function extractCommands(zip: string, dest: string): string[][] {
  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference='Stop'",
      // The progress bar costs most of Expand-Archive's runtime and prints to stdout.
      "$ProgressPreference='SilentlyContinue'",
      `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(dest)} -Force`,
    ].join("\n");
    return [psCommand(script), ["tar.exe", "-x", "-f", zip, "-C", dest]];
  }
  const commands = [["unzip", "-q", "-o", zip, "-d", dest]];
  if (process.platform === "darwin") commands.push(["ditto", "-x", "-k", zip, dest]);
  commands.push(["bsdtar", "-x", "-f", zip, "-C", dest]);
  return commands;
}

/**
 * Unpack `zip` into `dest`, reporting how much has landed. The first tool that
 * works wins; a failed attempt starts from a clean destination so a half-written
 * tree can never be mistaken for the next tool's output.
 */
async function extractArchive(
  zip: string,
  dest: string,
  totalBytes: number | null,
  job: Job,
  signal?: AbortSignal,
): Promise<void> {
  let failure = "";
  for (const cmd of extractCommands(zip, dest)) {
    if (signal?.aborted) throw new ReleaseError("cancelled", "安装已取消");
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    job.report("extracting", 0, totalBytes, true);
    const result = await run(cmd, { signal, onTick: () => job.report("extracting", treeBytes(dest), totalBytes) });
    if (signal?.aborted) throw new ReleaseError("cancelled", "安装已取消");
    if (result.code === 0) {
      job.report("extracting", treeBytes(dest), totalBytes, true);
      return;
    }
    failure = `${cmd[0]}：${lastLine(result.err.length > 0 ? result.err : result.out)}`;
    if (!result.missing) break; // a real extractor failed — do not paper over it
  }
  throw new ReleaseError("archive", `解压失败（${failure}）`);
}

/** Download straight to disk; the archive never sits in memory. */
async function downloadTo(
  url: URL,
  path: string,
  expected: number | null,
  job: Job,
  signal?: AbortSignal,
): Promise<number> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", headers: HEADERS, signal });
  } catch (cause) {
    if (signal?.aborted) throw new ReleaseError("cancelled", "安装已取消", { cause });
    throw new ReleaseError("network", `下载失败：${message(cause)}`, { cause });
  }
  if (res.url.length > 0) officialUrl(res.url, "跳转后的下载地址");
  if (!res.ok) throw new ReleaseError("network", `下载地址返回 HTTP ${res.status}`);
  if (res.body === null) throw new ReleaseError("network", "下载响应没有内容");
  const total = expected ?? responseSize(res);
  const reader = res.body.getReader();
  const sink = Bun.file(path).writer({ highWaterMark: 1 << 20 });
  let received = 0;
  let failure: unknown = null;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value === undefined) continue;
      await sink.write(chunk.value);
      received += chunk.value.byteLength;
      job.report("downloading", received, total);
      if (signal?.aborted) throw new ReleaseError("cancelled", "安装已取消");
    }
  } catch (cause) {
    failure = cause;
    await reader.cancel().catch(() => {});
  }
  try {
    await sink.end();
  } catch (cause) {
    failure ??= cause;
  }
  if (failure === null) {
    // The throttle may have dropped the last chunk's callback; the UI still needs
    // an exact byte count at the moment the phase changes.
    job.report("downloading", received, total, true);
  }
  if (failure !== null) {
    if (signal?.aborted) throw new ReleaseError("cancelled", "安装已取消", { cause: failure });
    throw failure instanceof ReleaseError
      ? failure
      : new ReleaseError("network", `下载失败：${message(failure)}`, { cause: failure });
  }
  if (expected !== null && received !== expected) {
    throw new ReleaseError("incomplete", `下载不完整：收到 ${received} 字节，官方说 ${expected} 字节，不拿它解压`);
  }
  return received;
}

/** A crashed run leaves its job directory behind; nothing may be running in it now. */
function pruneStaleJobs(parent: string): void {
  const cutoff = Date.now() - STALE_JOB_MS;
  for (const job of subdirectories(parent)) {
    try {
      if (statSync(job).mtimeMs < cutoff) rmSync(job, { recursive: true, force: true });
    } catch {
      /* in use or already gone: leave it */
    }
  }
}

function removeStaging(dir: string): void {
  const parent = join(ROOT, STAGING);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover neither breaks discovery nor blocks the next install */
  }
  try {
    if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true });
  } catch {
    /* parent missing or still holding another job */
  }
}

/**
 * The install pipeline shared by both entry points: lock, stage, extract, verify,
 * rename, then re-run discovery so the caller gets the same `VersionInfo` every
 * other surface sees. `stage` supplies the archive on disk (downloading it, or
 * handing over a file the operator already has).
 */
async function runInstall(
  identity: ReleaseIdentity,
  onProgress: InstallProgressHandler | undefined,
  signal: AbortSignal | undefined,
  stage: (job: Job) => Promise<string>,
): Promise<VersionInfo> {
  assertIdentity(identity);
  if (installing !== null) {
    throw new ReleaseError("busy", `正在安装 ${installing}；同一时间只装一个版本`);
  }
  const target = join(ROOT, identity.name);
  if (existsSync(target)) {
    throw new ReleaseError("exists", `已经装过 ${identity.name}（${target}），不会覆盖已有安装`);
  }
  if (signal?.aborted) throw new ReleaseError("cancelled", "安装已取消");

  installing = identity.name;
  const parent = join(ROOT, STAGING);
  const jobDir = join(parent, `${identity.name}-${randomUUID().slice(0, 8)}`);
  try {
    mkdirSync(jobDir, { recursive: true });
    pruneStaleJobs(parent);
    const job: Job = { dir: jobDir, report: reporter(onProgress) };
    const zip = await stage(job);
    if (!existsSync(zip)) throw new ReleaseError("install", `找不到要安装的 ZIP：${zip}`);
    const archiveBytes = statSync(zip).size;
    if (archiveBytes <= 0) throw new ReleaseError("archive", `ZIP 是空文件：${zip}`);

    const listing = await (process.platform === "win32" ? listArchiveWindows(zip) : listArchiveUnix(zip));
    if (listing === null)
      throw new ReleaseError("archive", "无法验证压缩包路径，已拒绝解压；请检查系统解压工具是否可用。");
    for (const entry of listing.entries) {
      const problem = entryProblem(entry);
      if (problem !== null) throw new ReleaseError("archive", problem);
    }
    // The ZIP is already on disk; reserve remaining room for the extracted tree.
    requireSpace(jobDir, listing.totalBytes > 0 ? listing.totalBytes : archiveBytes * 3);

    const dest = join(jobDir, "extract");
    await extractArchive(zip, dest, listing?.totalBytes ?? null, job, signal);

    const root = findServerRoot(dest);
    if (root === null) {
      throw new ReleaseError("triad", `解压后没找到同时含 ${TRIAD.join(" + ")} 的版本目录，装上去也开不了服`);
    }
    const embedded = EMBEDDED_VERSION.exec(basename(root));
    if (embedded !== null) {
      const version = [embedded[1], embedded[2], embedded[3]].map((part) => String(Number(part))).join(".");
      if (version !== identity.version) {
        throw new ReleaseError(
          "archive",
          `压缩包里的目录是 r5f-dedi-${version}，与发布版本 ${identity.version} 对不上，拒绝安装`,
        );
      }
    }
    if (existsSync(target)) {
      throw new ReleaseError("exists", `已经装过 ${identity.name}（${target}），不会覆盖已有安装`);
    }
    // Same volume, so this is an atomic rename: the version appears complete or not at all.
    renameSync(root, target);
    job.report("complete", archiveBytes, archiveBytes, true);
  } finally {
    installing = null;
    removeStaging(jobDir);
  }

  const installed = discoverVersions(ROOT).find((version) => version.name === identity.name);
  if (installed === undefined) {
    throw new ReleaseError("install", "文件已经就位，但它没被识别成服务端版本（目录里缺少三件套？）");
  }
  return installed;
}

/**
 * Install the published release: same origin and file-name checks as the check
 * that produced `ReleaseInfo`, then the shared pipeline. Resolves with the
 * discovered `VersionInfo`, or throws `ReleaseError`; a cancel during the
 * download throws with code `cancelled` and leaves nothing behind.
 */
export async function installRelease(
  release: ReleaseInfo,
  onProgress?: InstallProgressHandler,
  signal?: AbortSignal,
): Promise<VersionInfo> {
  const url = officialUrl(release.url, "下载地址");
  const filename = safeFilename(release.filename) ?? safeFilename(`${release.name}.zip`);
  if (filename === null) {
    throw new ReleaseError("filename", `下载文件名不可信：${JSON.stringify(release.filename)}`);
  }
  return runInstall(release, onProgress, signal, async (job) => {
    const zip = join(job.dir, filename);
    await downloadTo(url, zip, release.sizeBytes, job, signal);
    return zip;
  });
}

/**
 * Install from a ZIP already on this machine — the same extraction, verification
 * and placement path `installRelease` uses, without the download. Useful when the
 * file was fetched by hand or the CDN is unreachable from this host.
 */
export async function installArchive(
  zipPath: string,
  identity: ReleaseIdentity,
  onProgress?: InstallProgressHandler,
  signal?: AbortSignal,
): Promise<VersionInfo> {
  return runInstall(identity, onProgress, signal, async () => zipPath);
}
