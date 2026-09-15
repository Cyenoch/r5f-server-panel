/** 展示层格式化：只关心「怎么读」，不关心取数。 */

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 运行时长：`3 天 4 小时` / `4 小时 12 分` / `12 分 30 秒`。 */
export function formatDuration(fromIso: string, now = Date.now()): string {
  const started = Date.parse(fromIso);
  if (!Number.isFinite(started)) return "—";
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${secs} 秒`;
  return `${secs} 秒`;
}

/** 短时长：`4h12m` / `12m` / `38s`（表格里用，省横向空间）。 */
export function formatUptimeShort(fromIso: string, now = Date.now()): string {
  const started = Date.parse(fromIso);
  if (!Number.isFinite(started)) return "—";
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** CPU 秒数是累计值，按运行时长折算成"几个核"。 */
export function formatCpu(cpuSeconds: number, startedAtIso: string, now = Date.now()): string {
  const started = Date.parse(startedAtIso);
  if (!Number.isFinite(started) || cpuSeconds <= 0) return "—";
  const elapsed = Math.max(1, (now - started) / 1000);
  return `${(cpuSeconds / elapsed).toFixed(2)} 核`;
}

export function formatClock(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  return new Date(time).toLocaleTimeString("zh-CN", { hour12: false });
}

export function formatDateTime(ms: number | string): string {
  const time = typeof ms === "string" ? Date.parse(ms) : ms;
  if (!Number.isFinite(time)) return "—";
  return new Date(time).toLocaleString("zh-CN", { hour12: false });
}

/** 相对时间：`刚刚` / `3 分钟前` / `2 小时前` / 具体日期。 */
export function formatRelative(ms: number | string, now = Date.now()): string {
  const time = typeof ms === "string" ? Date.parse(ms) : ms;
  if (!Number.isFinite(time)) return "—";
  const diff = Math.round((now - time) / 1000);
  if (diff < 0) return formatDateTime(time);
  if (diff < 45) return "刚刚";
  if (diff < 3600) return `${Math.round(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.round(diff / 3600)} 小时前`;
  if (diff < 7 * 86400) return `${Math.round(diff / 86400)} 天前`;
  return formatDateTime(time);
}

/** 中文按 2 个字符宽算的中截断：表格单元格里保持列宽。 */
export function clip(text: string, max: number): string {
  if (max <= 1) return "";
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join("")}…`;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * 运行编号：引擎的目录名是 UUID，面板**不展示全量**，只留前 8 位。
 * 全量没有运维价值（路径就在本机），但截图/报障时是稳定的机器标识。
 */
export function shortId(id: string): string {
  const head = id.split("-")[0] ?? "";
  return id.length > 8 && head.length === 8 ? `${head}…` : id;
}

/** 把路径里出现的 UUID 换成短形式 —— 引擎的运行目录名就长这样。 */
export function maskPath(path: string): string {
  return path.replace(UUID, (match) => shortId(match));
}
