/**
 * 主机自己的公网 IPv4。
 *
 * 面板要把它写进 `+hostip`：NAT / 云主机上引擎自测只能得到 `[::1]:0`，主服据此判服务器
 * 不可达（证据见 README「上架失败排查」），所以对外公布的地址必须由面板显式给出。
 *
 * 取值的三条纪律：
 *   - **只走 HTTPS**，顺序固定；超时、非 200、重定向都算这一家不可信，换下一家。
 *   - **只认「整段响应就是一个 IPv4 字面量」**：HTML、JSON、多行、IPv6 一律拒绝，不从中
 *     猜一个地址出来。回显服务被劫持或改版时，宁可报「没取到」。
 *   - 都不行就**如实说没取到**，不拿本机网卡地址顶替 —— 把 `192.168.x.x` 写进 hostip
 *     比留空更糟：主服会拿它去探测，永远探测失败。
 *
 * 取到的是**本机出网时对外可见的地址**。主机上跑代理 / VPN（TUN 模式）时，这里报出来的
 * 可能不是主服看到的那个地址；那是主机网络配置问题，面板不替用户判断（README 同节）。
 */
const ECHO_ENDPOINTS = ["https://api.ipify.org", "https://ipv4.icanhazip.com", "https://ifconfig.me/ip"] as const;

const REQUEST_TIMEOUT_MS = 5000;

/**
 * 回显响应 -> IPv4 字面量，或 null。
 *
 * 前后空白可以有（多数服务带一个换行），除此之外必须是唯一、规范的点分十进制四段：
 * `1.2.3.4` 可以，`01.2.3.4`、`1.2.3`、`1.2.3.4\n1.2.3.5`、`::1`、`<html>…` 都不行。
 */
export function parseIpv4Echo(text: string): string | null {
  const value = text.trim();
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255 || String(Number(part)) !== part) return null;
  }
  return value;
}

export type PublicIpResult = { ok: true; ip: string; source: string } | { ok: false; reason: string };

/**
 * 依次问回显服务要本机的公网 IPv4。全部失败时返回原因列表，而不是抛错：调用方（面板按钮）
 * 要把它原样显示成一条 notice，失败原因是给用户看的运维信息。
 */
export async function detectPublicIp(options: { timeoutMs?: number } = {}): Promise<PublicIpResult> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const failures: string[] = [];
  for (const endpoint of ECHO_ENDPOINTS) {
    const source = new URL(endpoint).host;
    try {
      const response = await fetch(endpoint, {
        headers: { accept: "text/plain" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        failures.push(`${source} 返回 HTTP ${response.status}`);
        continue;
      }
      const ip = parseIpv4Echo(await response.text());
      if (ip === null) {
        failures.push(`${source} 的回答不是单个 IPv4 地址`);
        continue;
      }
      return { ok: true, ip, source };
    } catch (cause) {
      failures.push(`${source} ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return { ok: false, reason: `三个回显服务都没给出可信的公网 IPv4：${failures.join("；")}` };
}
