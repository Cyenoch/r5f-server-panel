// 把原生宿主与 JS 包放进实例根目录（r5-server.json、r5f-dedi-* 所在层）。
// 宿主按「与自己同级」找 JS 包与 CLI，所以发布就是这两次拷贝，不需要安装器。
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const desktop = resolve(import.meta.dirname, "..");
const root = resolve(desktop, "..");
const profile = process.argv.includes("--release") ? "release" : "debug";

const host = resolve(desktop, "native", "target", profile, "r5-server-gui.exe");
if (!existsSync(host))
  throw new Error(`缺少原生宿主，先跑：bun run host:build${profile === "release" ? ":release" : ""}`);

const bundle = resolve(desktop, "dist", "app.js");
if (!existsSync(bundle)) throw new Error("缺少 JS 包，先跑：bun run build");

copyFileSync(host, resolve(root, "r5-server-gui.exe"));
copyFileSync(bundle, resolve(root, "r5-server-gui.js"));
console.log(`已放入 ${root}：r5-server-gui.exe（${profile}）+ r5-server-gui.js`);
