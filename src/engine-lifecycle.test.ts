/**
 * 实例生命周期回归：启动 / 取消（停止）/ 退出 / 重启 / 失败，跑的都是**真实子进程**。
 *
 * 每个用例在 `mkdtemp` 里造一个开发沙箱（`R5F_DEV=1` + `R5_SERVER_ROOT=<沙箱>`），一个短驱动
 * 脚本按面板自己的入口做事（`panel.launchInstance` / `killInstance` / `restartInstance` /
 * `sendConsole`，以及驱动直接重入的 `__dev-engine` worker）。断言只看观察得到的东西：进程是否
 * 还在、状态文件里的运行记录、引擎自己写的快照、日志、控制通道回执 —— 没有替身。
 *
 * 进程权限：**绝不对快照里的 pid 发信号**（那个 pid 可能已经被系统复用成别的进程，见
 * `src/dev-protocol.ts` 的停止路径说明）。停止一律走面板自己的鉴权控制通道；需要信号的用例
 * （SIGTERM / SIGKILL）由驱动自己 spawn 引擎并持有真实子进程句柄，只对这个句柄发信号。
 * 进程退出是跨进程事件，只能由驱动侧按存活探测等它，测试文件里因此没有 sleep/定时器。
 *
 * 平台：`SIGKILL`/`SIGTERM` 与存活探测在 macOS / Linux 有效；Windows 的 `process.kill` 是
 * TerminateProcess，那两个用例在那里没有等价语义，用 `skipIf` 明确跳过。
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
/** 驱动脚本落进沙箱：它 import 仓库里的模块，沙箱只提供 env 与状态文件。 */
const DRIVER = "lifecycle-driver.ts";
const WINDOWS = process.platform === "win32";
const devProtocol = JSON.stringify(join(REPO, "src/dev-protocol.ts"));
const instances = JSON.stringify(join(REPO, "src/instances.ts"));
const panel = JSON.stringify(join(REPO, "src/panel.ts"));
const stateModule = JSON.stringify(join(REPO, "src/state.ts"));
const tap = JSON.stringify(join(REPO, "src/tap.ts"));
const win = JSON.stringify(join(REPO, "src/win.ts"));

const DRIVER_SOURCE = `import { join } from "node:path";
import { liveDevEngineSnapshots, readDevEngineSnapshots, requestDevStop } from ${devProtocol};
import { workspaceDir } from ${instances};
import { killInstance, launchInstance, restartInstance, sendConsole } from ${panel};
import { ROOT, loadState, withState } from ${stateModule};
import { WORKER_OPS, isPidAlive, logDir, workerCommand, workerSpawnEnv } from ${tap};
import { getProcess } from ${win};

const [op, ...args] = process.argv.slice(2);
const report = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const firstInstance = () => loadState().instances[0] ?? null;

/** 面板眼里的运行记录：状态文件里那条 + 进程是否还在（与 runtimeAlive 同一判据）。 */
function runtimeRecord() {
  const runtime = firstInstance()?.runtime ?? null;
  if (runtime === null) return null;
  return {
    pid: runtime.pid,
    port: runtime.port,
    ctlPort: runtime.ctlPort ?? 0,
    logFile: runtime.logFile ?? "",
    engineDir: runtime.engineDir ?? "",
    alive: getProcess(runtime.pid) !== null,
  };
}

function stateReport() {
  const instance = firstInstance();
  return {
    ok: true,
    root: ROOT,
    instance: instance ? instance.id : "",
    version: instance ? instance.version : null,
    runtime: runtimeRecord(),
    live: liveDevEngineSnapshots().map((entry) => ({ pid: entry.pid, port: entry.port })),
    snapshots: readDevEngineSnapshots().length,
  };
}

function launchReport(result) {
  if (!result.ok) return { ok: false, error: result.error, hint: result.hint ?? "" };
  return {
    ok: true,
    pid: result.pid,
    port: result.port,
    bound: result.bound,
    logFile: result.logFile ?? "",
    versionPath: result.versionPath,
  };
}

/** 等到进程真的没了（只等，不发信号；引擎不是本测试的子进程）。 */
async function waitGone(pid, budgetMs = 8000) {
  const deadline = Date.now() + budgetMs;
  while (isPidAlive(pid) && Date.now() < deadline) await Bun.sleep(20);
  return !isPidAlive(pid);
}

/**
 * 自己 spawn 的句柄收尾：退出必须被确认。child.killed 为真说明已经退出；否则补一刀，杀不动时
 * 再用存活探测确认 —— 确实还活着才算真失败（ESRCH 只是"已经不在"，不是失败）。
 */
async function settleOwned(child) {
  let killFailure = null;
  if (!child.killed) {
    try {
      child.kill("SIGKILL");
    } catch (error) {
      killFailure = error;
    }
  }
  await child.exited;
  if (killFailure !== null && isPidAlive(child.pid)) {
    throw new Error("自己 spawn 的模拟引擎没有退出（pid " + child.pid + "）：" + killFailure);
  }
}

/** 面板 spawn 引擎用的同一条 argv 契约；这里由驱动自己 spawn，句柄归驱动。 */
function engineCommand(instance, logFile, token) {
  return workerCommand([
    WORKER_OPS.devEngine,
    "--instance",
    instance.id,
    "--version-path",
    workspaceDir(instance.id),
    "--settings",
    JSON.stringify(instance.settings),
    "--log",
    logFile,
    "--ctl-token",
    token,
  ]);
}

async function main() {
  switch (op) {
    case "state":
      report(stateReport());
      return;
    case "launch":
      report(launchReport(await launchInstance(loadState(), { instance: args[0] })));
      return;
    case "restart":
      report(launchReport(await restartInstance(loadState(), { instance: args[0] })));
      return;
    case "stop":
      try {
        report({ ok: true, killed: killInstance(loadState()) });
      } catch (error) {
        report({ ok: false, error: String(error) });
      }
      return;
    case "console": {
      const receipt = await sendConsole(loadState(), args[0]);
      if (receipt === "no-control") {
        report({ ok: true, noControl: true });
        return;
      }
      report({ ok: true, kind: receipt.kind, detail: receipt.detail, lines: receipt.lines });
      return;
    }
    case "set-version": {
      const target = firstInstance();
      if (target === null) throw new Error("沙箱里没有实例");
      const wanted = args[0].length > 0 ? args[0] : null;
      withState(loadState(), (disk) => {
        const live = disk.instances.find((entry) => entry.id === target.id);
        if (live !== undefined) live.version = wanted;
      });
      report({ ok: true, version: wanted });
      return;
    }
    case "wait-exit": {
      const pid = Number(args[0]);
      report({ ok: true, gone: await waitGone(pid, Number(args[1] ?? 8000)) });
      return;
    }
    case "engine-exit": {
      // 引擎按面板自己的鉴权停止请求退出，但**不走** killInstance：运行记录因此变成陈旧记录，
      // 下一次面板停止要处理的是"记录还在、进程已经不在"。
      const record = firstInstance()?.runtime ?? null;
      if (record === null) throw new Error("沙箱里没有运行记录");
      const stopped = await requestDevStop(record.pid);
      report({ ok: true, stopped, gone: await waitGone(record.pid) });
      return;
    }
    case "spawn-owned": {
      // 需要信号的用例：自己 spawn、自己持有句柄，信号只发给这个句柄，绝不按快照里的 pid 发。
      const mode = args[0];
      const instance = firstInstance();
      if (instance === null) throw new Error("沙箱里没有实例");
      const logFile = join(logDir(ROOT), "owned-" + mode + ".log");
      const child = Bun.spawn(engineCommand(instance, logFile, "owned-" + mode), {
        cwd: ROOT,
        env: workerSpawnEnv(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20000,
      });
      const stderr = new Response(child.stderr).text();
      const pid = child.pid;
      try {
        let text = "";
        let ctlPort = 0;
        const reader = child.stdout.getReader();
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += Buffer.from(chunk.value).toString("utf8");
          const match = /READY (\\d+)/.exec(text);
          if (match) {
            ctlPort = Number.parseInt(match[1], 10);
            break;
          }
        }
        if (ctlPort === 0) {
          report({ ok: false, error: "引擎没有就绪", stderr: await stderr });
          return;
        }
        if (mode === "term") child.kill("SIGTERM");
        else if (mode === "kill") child.kill("SIGKILL");
        else throw new Error("未知的信号模式 " + mode);
        const code = await child.exited;
        report({
          ok: true,
          pid,
          ctlPort,
          code,
          logFile,
          gone: await waitGone(pid),
          snapshots: readDevEngineSnapshots().length,
          live: liveDevEngineSnapshots().length,
          stderr: await stderr,
        });
        return;
      } finally {
        await settleOwned(child);
      }
    }
    case "raw-engine": {
      // 绕过面板的守卫，按 worker 的重入契约再起一个模拟引擎：拿它自己的退出码。
      const instance = firstInstance();
      if (instance === null) throw new Error("沙箱里没有实例");
      const child = Bun.spawn(engineCommand(instance, join(logDir(ROOT), "duplicate.log"), "duplicate-probe"), {
        cwd: ROOT,
        env: workerSpawnEnv(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
      });
      try {
        const [stdout, stderr] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        report({ ok: true, code: await child.exited, stdout, stderr });
        return;
      } finally {
        await settleOwned(child);
      }
    }
    default:
      throw new Error("未知的驱动操作 " + op);
  }
}

main().catch((error) => {
  process.stderr.write(String((error && error.stack) || error) + "\\n");
  process.exit(1);
});
`;

type Report = Record<string, unknown>;
type RuntimeRecord = {
  pid: number;
  port: number;
  ctlPort: number;
  logFile: string;
  engineDir: string;
  alive: boolean;
};
type StateReport = {
  instance: string;
  version: string | null;
  runtime: RuntimeRecord | null;
  live: number[];
  snapshots: number;
};

const isNumber = (value: unknown): value is number => typeof value === "number";
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => value === true || value === false;
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** 驱动报告里的一次取值：脚本是本仓库自己的，但断言不建立在"它一定给了"之上。 */
function field<T>(report: Report, key: string, check: (value: unknown) => value is T): T {
  const value = report[key];
  if (!check(value)) throw new Error(`驱动报告里的 ${key} 不是预期类型（${typeof value}）`);
  return value;
}

function asReport(value: unknown): Report {
  if (typeof value !== "object" || value === null) throw new Error("驱动报告里的对象字段不是对象");
  return value as Record<string, unknown>;
}

function runtimeOf(value: unknown): RuntimeRecord | null {
  if (value === null || value === undefined) return null;
  const record = asReport(value);
  return {
    pid: field(record, "pid", isNumber),
    port: field(record, "port", isNumber),
    ctlPort: field(record, "ctlPort", isNumber),
    logFile: field(record, "logFile", isString),
    engineDir: field(record, "engineDir", isString),
    alive: field(record, "alive", isBoolean),
  };
}

function stateOf(report: Report): StateReport {
  const live = Array.isArray(report.live) ? report.live : [];
  return {
    instance: field(report, "instance", isString),
    version: report.version === null ? null : field(report, "version", isString),
    runtime: runtimeOf(report.runtime),
    live: live.map((entry) => field(asReport(entry), "pid", isNumber)),
    snapshots: field(report, "snapshots", isNumber),
  };
}

/**
 * 沙箱里跑一条驱动操作。`timeout` 是**看门狗**（挂住就杀掉自己 spawn 的驱动），不是等待：
 * 等待都在驱动侧按真实事件做。
 */
async function drive(root: string, op: string, ...args: string[]): Promise<Report> {
  const child = Bun.spawn([process.execPath, "run", join(root, DRIVER), op, ...args], {
    cwd: root,
    env: {
      ...process.env,
      R5F_DEV: "1",
      R5_SERVER_ROOT: root,
      R5_SERVER_PACKAGED: "0",
      R5_SERVER_DAEMON: "",
      R5_SERVER_WORKER_ARGS: "",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`驱动 ${op} 退出码 ${code}：\n${stderr.trim()}\n${stdout.trim()}`);
  return asReport(JSON.parse(stdout.trim().split("\n").at(-1) ?? "null"));
}

const inspect = async (root: string): Promise<StateReport> => stateOf(await drive(root, "state"));
/** 等到引擎真的退出（驱动侧有界等待，等的是内核里的进程消失）。 */
const awaitExit = async (root: string, pid: number): Promise<boolean> =>
  field(await drive(root, "wait-exit", String(pid)), "gone", isBoolean);

type Sandbox = { root: string; instance: string; dispose: () => Promise<void> };

async function sandbox(): Promise<Sandbox> {
  // 沙箱根必须是**真实路径**：dev-engine 的沙箱检查把 realpath 后的路径与 DEV_ROOT 逐字比
  // （macOS 上 /var → /private/var、/tmp 也是符号链接，直接 mkdtemp 出来的路径会被它拒绝）。
  const root = realpathSync(mkdtempSync(join(tmpdir(), "r5-lifecycle-")));
  writeFileSync(join(root, DRIVER), DRIVER_SOURCE);
  const seeded = await inspect(root);
  return {
    root,
    instance: seeded.instance,
    dispose: async () => {
      // 收尾只走面板自己的鉴权停止，绝不发信号。**任何一步不能确认"引擎已经没了"，就保留沙箱并
      // 报错** —— 静默删目录、或者吞掉异常照删，都会把"还有进程活着"变成假绿。
      const stopped = await drive(root, "stop", seeded.instance);
      if (stopped.ok !== true) {
        throw new Error(`r5-lifecycle: 沙箱 ${root} 停止失败（${String(stopped.error)}），沙箱已保留。`);
      }
      for (const pid of (await inspect(root)).live) {
        const gone = await awaitExit(root, pid);
        if (!gone) throw new Error(`r5-lifecycle: 面板停止后引擎 pid ${pid} 仍然存活，沙箱 ${root} 已保留。`);
      }
      // 再确认一次：这一轮等待期间不该有新引擎出现，出现了就同样保留沙箱（不删）。
      const survivors = (await inspect(root)).live;
      if (survivors.length > 0) {
        throw new Error(`r5-lifecycle: 沙箱 ${root} 仍有存活引擎 ${survivors.join(", ")}，目录已保留。`);
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("启动：模拟引擎作为真实子进程起来，面板记下 pid/控制口/日志，引擎自己写下快照", async () => {
  const box = await sandbox();
  try {
    const launched = await drive(box.root, "launch", box.instance);
    expect(launched.ok).toBe(true);
    const pid = field(launched, "pid", isNumber);
    expect(pid).toBeGreaterThan(0);
    expect(field(launched, "bound", isBoolean)).toBe(true);

    const after = await inspect(box.root);
    expect(after.runtime?.pid).toBe(pid);
    expect(after.runtime?.ctlPort).toBeGreaterThan(0);
    expect(after.runtime?.alive).toBe(true);
    expect(after.live).toEqual([pid]);
    expect(after.snapshots).toBe(1);

    // 引擎自己写的那份日志：面板日志页与回执读的就是它。
    const log = readFileSync(field(launched, "logFile", isString), "utf8");
    expect(log).toContain("simulated engine ready");
    expect(log).toContain("no real game engine");
  } finally {
    await box.dispose();
  }
});

test("重复启动被两层挡住：面板拒绝第二次，绕过面板时引擎自己以退出码 3 退出", async () => {
  const box = await sandbox();
  try {
    const first = await drive(box.root, "launch", box.instance);
    expect(first.ok).toBe(true);

    const second = await drive(box.root, "launch", box.instance);
    expect(second.ok).toBe(false);

    // 绕过面板守卫直接重入 worker：引擎自己按"已有实例"拒绝，退出码 3 是它的契约。
    const raw = await drive(box.root, "raw-engine");
    expect(field(raw, "code", isNumber)).toBe(3);

    // 两次尝试都不该动到已经跑着的那个进程。
    const after = await inspect(box.root);
    expect(after.live).toEqual([field(first, "pid", isNumber)]);
    expect(after.runtime?.alive).toBe(true);
  } finally {
    await box.dispose();
  }
});

test("停止（取消运行）：走引擎自己的控制通道确认退出，进程、快照与运行记录一起清掉", async () => {
  const box = await sandbox();
  try {
    const first = await drive(box.root, "launch", box.instance);
    expect(first.ok).toBe(true);
    const pid = field(first, "pid", isNumber);

    const stopped = await drive(box.root, "stop", box.instance);
    expect(stopped.ok).toBe(true);
    expect(field(stopped, "killed", isNumber)).toBe(1);
    expect(await awaitExit(box.root, pid)).toBe(true);

    const after = await inspect(box.root);
    expect(after.runtime).toBeNull();
    expect(after.live).toEqual([]);
    expect(after.snapshots).toBe(0);
  } finally {
    await box.dispose();
  }
});

test("重启：先停再起，新 pid 接管，旧 pid 不再存活，同时只有一个引擎", async () => {
  const box = await sandbox();
  try {
    const first = await drive(box.root, "launch", box.instance);
    expect(first.ok).toBe(true);
    const oldPid = field(first, "pid", isNumber);

    const restarted = await drive(box.root, "restart", box.instance);
    expect(restarted.ok).toBe(true);
    const newPid = field(restarted, "pid", isNumber);
    expect(newPid).not.toBe(oldPid);
    expect(await awaitExit(box.root, oldPid)).toBe(true);

    const after = await inspect(box.root);
    expect(after.live).toEqual([newPid]);
    expect(after.runtime?.pid).toBe(newPid);
    expect(after.runtime?.alive).toBe(true);
  } finally {
    await box.dispose();
  }
});

test("陈旧运行记录：引擎先退出，面板停止只清理记录、不谎报停过，之后还能重启", async () => {
  const box = await sandbox();
  try {
    const first = await drive(box.root, "launch", box.instance);
    expect(first.ok).toBe(true);

    // 引擎按面板自己的鉴权停止请求退出（不走 killInstance）：记录因此陈旧。
    const exited = await drive(box.root, "engine-exit");
    expect(field(exited, "stopped", isBoolean)).toBe(true);
    expect(field(exited, "gone", isBoolean)).toBe(true);

    const stale = await inspect(box.root);
    expect(stale.runtime).not.toBeNull();
    expect(stale.runtime?.alive).toBe(false);
    expect(stale.live).toEqual([]);
    expect(stale.snapshots).toBe(0);

    const stopped = await drive(box.root, "stop", box.instance);
    expect(stopped.ok).toBe(true);
    expect(field(stopped, "killed", isNumber)).toBe(0);
    expect((await inspect(box.root)).runtime).toBeNull();

    const again = await drive(box.root, "launch", box.instance);
    expect(again.ok).toBe(true);
    expect(field(again, "pid", isNumber)).not.toBe(field(first, "pid", isNumber));
  } finally {
    await box.dispose();
  }
});

test.skipIf(WINDOWS)("优雅自退（SIGTERM）：引擎自己收尾并删掉快照", async () => {
  const box = await sandbox();
  try {
    // 先让面板建好实例工作副本，再把面板那个实例停掉（缓存与记录都清干净）。
    const first = await drive(box.root, "launch", box.instance);
    expect(first.ok).toBe(true);
    expect(field(await drive(box.root, "stop", box.instance), "killed", isNumber)).toBe(1);
    expect(await awaitExit(box.root, field(first, "pid", isNumber))).toBe(true);

    // 信号只发给本测试自己 spawn 的句柄。
    const owned = await drive(box.root, "spawn-owned", "term");
    expect(owned.ok).toBe(true);
    expect(field(owned, "code", isNumber)).toBe(0);
    expect(field(owned, "gone", isBoolean)).toBe(true);
    expect(field(owned, "snapshots", isNumber)).toBe(0);
    expect(field(owned, "live", isNumber)).toBe(0);
  } finally {
    await box.dispose();
  }
});

test.skipIf(WINDOWS)("崩溃（SIGKILL）：陈旧快照留在磁盘上，但按 pid 存活判定不算活着，且仍能重启", async () => {
  const box = await sandbox();
  try {
    const first = await drive(box.root, "launch", box.instance);
    expect(first.ok).toBe(true);
    expect(field(await drive(box.root, "stop", box.instance), "killed", isNumber)).toBe(1);
    expect(await awaitExit(box.root, field(first, "pid", isNumber))).toBe(true);

    const owned = await drive(box.root, "spawn-owned", "kill");
    expect(owned.ok).toBe(true);
    expect(field(owned, "code", isNumber)).not.toBe(0);
    expect(field(owned, "gone", isBoolean)).toBe(true);
    // 被 KILL 的引擎来不及清快照：文件还在，但 pid 已经不存活，所以不算"活着的实例"。
    expect(field(owned, "snapshots", isNumber)).toBe(1);
    expect(field(owned, "live", isNumber)).toBe(0);

    const again = await drive(box.root, "launch", box.instance);
    expect(again.ok).toBe(true);
    expect((await inspect(box.root)).live).toEqual([field(again, "pid", isNumber)]);
  } finally {
    await box.dispose();
  }
});

test("失败：实例没选版本时启动被明确拒绝，不留进程也不留运行记录", async () => {
  const box = await sandbox();
  try {
    const first = await drive(box.root, "launch", box.instance);
    expect(first.ok).toBe(true);
    expect(field(await drive(box.root, "stop", box.instance), "killed", isNumber)).toBe(1);
    expect(await awaitExit(box.root, field(first, "pid", isNumber))).toBe(true);

    await drive(box.root, "set-version", "");
    expect((await inspect(box.root)).version).toBeNull();
    const refused = await drive(box.root, "launch", box.instance);
    expect(refused.ok).toBe(false);

    const after = await inspect(box.root);
    expect(after.runtime).toBeNull();
    expect(after.live).toEqual([]);
  } finally {
    await box.dispose();
  }
});

test("托管控制台：面板发的命令真的进了引擎日志，并按引擎输出判定回执", async () => {
  const box = await sandbox();
  try {
    expect((await drive(box.root, "launch", box.instance)).ok).toBe(true);

    const status = await drive(box.root, "console", "status");
    expect(field(status, "kind", isString)).toBe("success");
    expect(field(status, "detail", isString)).toContain("hostname:");
    expect(field(status, "lines", isStringArray).join("\n")).toContain("players : 2 humans, 1 bots");

    const kick = await drive(box.root, "console", 'kick "1"');
    expect(field(kick, "kind", isString)).toBe("success");
    expect(field(kick, "detail", isString)).toContain("Kicked '1' from server");

    // "命令不存在"的判定同样来自引擎自己的输出，不是我们的猜测。
    const unknown = await drive(box.root, "console", "definitely_not_a_command");
    expect(field(unknown, "kind", isString)).toBe("unknown");
  } finally {
    await box.dispose();
  }
});

test("沙箱隔离：日志、快照与工作副本都落在会话自己的根目录里", async () => {
  const box = await sandbox();
  try {
    expect((await drive(box.root, "launch", box.instance)).ok).toBe(true);
    const runtime = (await inspect(box.root)).runtime;

    expect(runtime?.logFile.startsWith(box.root)).toBe(true);
    expect(runtime?.engineDir.startsWith(box.root)).toBe(true);
    // 工作副本必须是实例自己的：换版本或写配置只影响它。
    expect(runtime?.engineDir).toContain(box.instance);
    expect(existsSync(join(box.root, ".dev", "r5f", "engines", `${box.instance}.json`))).toBe(true);
    expect(existsSync(join(box.root, ".dev", "r5f", "r5-server.json"))).toBe(true);
  } finally {
    await box.dispose();
  }
});
