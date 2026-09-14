/** 一次性：验证 `ban --minutes` 拒绝路径不向引擎发送任何字节（水位线前后相等）。 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cmdModerate, logWatermark } from "../src/commands.ts";
import { ROOT, loadState } from "../src/state.ts";

const state = loadState();
const dir = join(ROOT, "logs");
const newest = readdirSync(dir)
  .filter((name) => name.endsWith(".log"))
  .map((name) => ({ name, m: statSync(join(dir, name)).mtimeMs }))
  .sort((a, b) => b.m - a.m)[0];
const path = state.runtime?.logFile ?? join(dir, newest.name);
console.log(`水位线文件：${path}`);
const before = await logWatermark(path);
process.exitCode = await cmdModerate(state, "ban", "1", { minutes: 30 });
const after = await logWatermark(path);
console.log(`水位线 ${before} -> ${after} ${before === after ? "相等 ✓（没有发出任何字节）" : "不等 ✗"}`);
console.log(`退出码 ${process.exitCode}`);
