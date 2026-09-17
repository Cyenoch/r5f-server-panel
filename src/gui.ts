import { existsSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT, IS_COMPILED } from "./paths";
import { red } from "./ui";

/** Source runs use Vite; packaged hosts run independently of the CLI and data directory. */
export async function launchGui(production: boolean): Promise<number> {
  if (!IS_COMPILED && !production) {
    const child = Bun.spawn([process.execPath, "run", "gui"], {
      cwd: APP_ROOT,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await child.exited;
  }

  const name = process.platform === "win32" ? "r5-server-gui.exe" : "r5-server-gui";
  const exe = join(APP_ROOT, name);
  if (!existsSync(exe)) {
    process.stderr.write(`${red(`找不到桌面面板：${exe}`)}\n`);
    process.stderr.write(
      IS_COMPILED
        ? "  请将原生面板与 r5-server-gui.js 放在 CLI 可执行文件同一目录。\n"
        : "  在项目根目录依次执行（每条单独运行）：\n    git submodule update --init --recursive\n    bun install\n    bun run gui:stage\n  日常开发无需 stage，直接运行：bun run gui\n",
    );
    return 1;
  }
  const child = Bun.spawn({
    cmd: [exe, "--production"],
    cwd: APP_ROOT,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
    detached: true,
  });
  child.unref();
  console.log(`已启动桌面面板（pid ${child.pid}）。`);
  return 0;
}
