/**
 * `+hostip` 的启动参数契约。
 *
 * 实测（用户报告）：`+hostip` 必须给 `ip:port`，只写 IP 时引擎对外公布的端口不对 —— 主服
 * 拿那个地址去探测必然失败，服务器上不了架。所以面板在拼启动参数时统一补上本实例的游戏端口，
 * 这条契约不能只在界面上「看着对」。
 */
import { expect, test } from "bun:test";
import { hostipArgument } from "./commands";
import { defaultSettings } from "./state";

test("hostip argument carries the instance game port when the value has none", () => {
  const settings = { ...defaultSettings, port: 37020, hostip: "203.0.113.7" };
  expect(hostipArgument(settings)).toBe("203.0.113.7:37020");
});

test("hostip argument keeps an explicit port and trims surrounding space", () => {
  const settings = { ...defaultSettings, port: 37020, hostip: "203.0.113.7:40000" };
  expect(hostipArgument(settings)).toBe("203.0.113.7:40000");
  expect(hostipArgument({ ...settings, hostip: "  203.0.113.7  " })).toBe("203.0.113.7:37020");
});

test("hostip argument stays absent when the field is empty or blank", () => {
  expect(hostipArgument({ ...defaultSettings, hostip: "" })).toBe("");
  expect(hostipArgument({ ...defaultSettings, hostip: "   " })).toBe("");
});
