/**
 * 回显响应的接受规则。
 *
 * 这个函数是「公网地址」唯一防伪环节：回显服务被劫持、被 CDN 换成错误页、或改版返回 JSON 时，
 * 只有它会拦住垃圾。放进去的值会进 `+hostip`，主服照它去探测 —— 错一个字节服务器就不上架，
 * 所以拒绝面必须比接受面大得多。
 */
import { expect, test } from "bun:test";
import { parseIpv4Echo } from "./publicip";

test("echo parsing accepts a bare IPv4 literal with surrounding whitespace", () => {
  expect(parseIpv4Echo("203.0.113.7")).toBe("203.0.113.7");
  expect(parseIpv4Echo("203.0.113.7\n")).toBe("203.0.113.7");
  expect(parseIpv4Echo("  203.0.113.7  ")).toBe("203.0.113.7");
});

test("echo parsing rejects anything that is not one canonical IPv4 address", () => {
  const rejected = [
    "",
    "203.0.113",
    "203.0.113.7.8",
    "203.0.113.256",
    "203.0.113.07",
    "::1",
    "2001:db8::1",
    "<html>203.0.113.7</html>",
    '{"ip":"203.0.113.7"}',
    "203.0.113.7\n198.51.100.9",
    "IP: 203.0.113.7",
  ];
  for (const text of rejected) expect(parseIpv4Echo(text)).toBeNull();
});
