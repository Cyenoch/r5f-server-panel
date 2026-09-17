// 把原生宿主与 JS 包放进实例根目录（r5-server.json、r5f-dedi-* 所在层）。
// 宿主按「与自己同级」找 JS 包与 CLI，所以发布就是这两次拷贝，不需要安装器。
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const profile = process.argv.includes("--release") ? "release" : "debug";

const name = process.platform === "win32" ? "r5-server-gui.exe" : "r5-server-gui";
const host = resolve(root, "native", "target", profile, name);
if (!existsSync(host))
  throw new Error(`缺少原生宿主，先跑：bun run host:build${profile === "release" ? ":release" : ""}`);

const bundle = resolve(root, "dist", "app.js");
if (!existsSync(bundle)) throw new Error("缺少 JS 包，先跑：bun run gui:build");

copyFileSync(host, resolve(root, name));
copyFileSync(bundle, resolve(root, "r5-server-gui.js"));
console.log(`已放入 ${root}：${name}（${profile}）+ r5-server-gui.js`);
