import { Command, CommanderError } from "commander";
import { render } from "ink";
/**
 * r5-server entry point.
 *
 *   r5-server                 Ink dashboard (interactive)
 *   r5-server <command>       commander-parsed subcommand, script friendly
 *   r5-server __logd ...      hidden hosted-console daemon
 *
 * Argument parsing: commander. Dashboard: Ink. Everything else is shared with
 * the plain CLI path, so a scheduled task and an interactive operator run the
 * same code.
 */
import React from "react";
import {
  applySettingInPlace,
  cmdAnnounce,
  cmdAnnouncements,
  cmdAutostart,
  cmdBanlist,
  cmdBotsAdd,
  cmdBotsClear,
  cmdBotsList,
  cmdConsole,
  cmdDoctor,
  cmdHealth,
  cmdList,
  cmdLogs,
  cmdModeList,
  cmdModeSet,
  cmdModerate,
  cmdPlayers,
  cmdSettings,
  cmdSetup,
  cmdStart,
  cmdStatus,
  cmdStop,
  cmdUpgrade,
  cmdUse,
  type SettingChange,
} from "./commands";
import type { Route } from "./keys";
import { type FieldId } from "./settings-fields";
import { ROOT, loadState } from "./state";
import { runLogDaemon, selfCommand, stripAnsi } from "./tap";
import { Dashboard } from "./tui";
import { closePrompt, red } from "./ui";
import { initConsole } from "./win";

const CLI_VERSION = "2.0.0";

initConsole();
const state = loadState();

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/** Commander's help layout has a few built-in English headings; translate them
 *  at the output boundary so a single place owns the wording. */
const HEADINGS: Record<string, string> = {
  "Usage:": "用法：",
  "Options:": "选项：",
  "Commands:": "命令：",
  "Arguments:": "参数：",
  "Global Options:": "全局选项：",
  "Help:": "帮助：",
};

function localiseHelp(text: string): string {
  let out = text;
  for (const [english, chinese] of Object.entries(HEADINGS)) {
    out = out.replace(new RegExp(`^${english}`, "m"), chinese);
  }
  return out
    .replace(/display help for command/g, "显示帮助")
    .replace(/^(用法|选项|命令|参数|全局选项|帮助)：[ \t]+/gm, "$1：");
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("r5-server")
    .description("R5Flowstate 专用服务器管理（多版本 / 日志流 / 自启 / 升级）")
    .version(CLI_VERSION, "-v, --version", "显示版本")
    .helpOption("-h, --help", "显示帮助")
    .configureOutput({
      writeOut: (str) => process.stdout.write(localiseHelp(str)),
      writeErr: (str) => process.stderr.write(localiseHelp(str)),
    })
    .exitOverride();

  program
    .command("list")
    .description("列出根目录下的可用版本")
    .option("--fast", "跳过体积统计")
    .action((opts: { fast?: boolean }) => {
      cmdList(state, { withSizes: !opts.fast });
    });

  program
    .command("use")
    .argument("[dir]", "版本目录名，例如 r5f-dedi-1.0.13")
    .description("选择/切换当前使用的版本")
    .action(async (dir?: string) => {
      process.exitCode = await cmdUse(state, dir);
    });

  program
    .command("start")
    .description("启动当前版本（未选择时会先让你选）")
    .option("--port <n>", "UDP 端口")
    .option("--map <stem>", "启动地图")
    .option("--playlist <id>", "启动即进入某模式")
    .option("--visibility <n>", "0=离线 1=隐藏 2=公开")
    .option("--auth <n>", "sv_onlineAuthMode 0/1/2")
    .option("--password <pw>", "服务器密码")
    .option("--hostname <name>", "服务器名")
    .option("--foreground", "前台运行（Ctrl+C 结束）")
    .option("--no-restart", "前台模式下退出后不自动重启")
    .option("--no-host", "不启用托管控制台（日志只在引擎窗口）")
    .option("--force", "已有实例或端口占用时仍然启动")
    .option("--detach", "后台运行（默认）")
    .action(async (opts: Record<string, unknown>) => {
      process.exitCode = await cmdStart(state, {
        port: numberOrUndefined(opts.port, "--port"),
        map: stringOrUndefined(opts.map),
        playlist: stringOrUndefined(opts.playlist),
        visibility: levelOrUndefined(opts.visibility, "--visibility"),
        auth: levelOrUndefined(opts.auth, "--auth"),
        password: stringOrUndefined(opts.password),
        hostname: stringOrUndefined(opts.hostname),
        foreground: Boolean(opts.foreground),
        noRestart: opts.restart === false,
        hosted: opts.host !== false,
        force: Boolean(opts.force),
      });
    });

  program
    .command("stop")
    .description("停止实例（含日志守护）")
    .option("--all", "停止本目录下所有实例")
    .action((opts: { all?: boolean }) => {
      process.exitCode = cmdStop(state, { all: Boolean(opts.all) });
    });

  program
    .command("restart")
    .description("重启当前版本")
    .action(async () => {
      cmdStop(state, {});
      process.exitCode = await cmdStart(state, {});
    });

  program
    .command("status")
    .description("状态：人数/地图/CPU/帧耗时/内存/端口/日志/自启")
    .option("--watch", "每 3 秒刷新")
    .action(async (opts: { watch?: boolean }) => {
      process.exitCode = await cmdStatus(state, { watch: Boolean(opts.watch) });
    });

  program
    .command("logs")
    .description("查看服务器日志（默认本次运行；--all 列出分片）")
    .option("-f, --follow", "实时跟随本次运行")
    .option("--lines <n>", "先显示最后 N 行", "40")
    .option("--all", "列出全部运行分片（最新在前）")
    .option("--run <id>", "读取指定分片（runid 或文件名）")
    .action(async (opts: { follow?: boolean; lines?: string; all?: boolean; run?: string }) => {
      process.exitCode = await cmdLogs(state, {
        follow: Boolean(opts.follow),
        lines: Number(opts.lines) || 40,
        all: Boolean(opts.all),
        run: stringOrUndefined(opts.run),
      });
    });

  program
    .command("autostart")
    .argument("[action]", "enable | disable | status | run", "status")
    .description("开机自启（计划任务）")
    .option("--trigger <when>", "logon | startup")
    .option("--task-name <name>", "计划任务名")
    .option("--args <extra>", '附加启动参数，例如 "--port 37016"')
    .option("--dry-run", "只打印将执行的命令")
    .action(async (action: string, opts: { trigger?: string; taskName?: string; args?: string; dryRun?: boolean }) => {
      if (!["enable", "disable", "status", "run"].includes(action)) {
        console.log(red("用法：r5-server autostart <enable|disable|status|run>"));
        process.exitCode = 1;
        return;
      }
      if (opts.trigger !== undefined && !["logon", "startup"].includes(opts.trigger)) {
        console.log(red("--trigger 只能是 logon / startup"));
        process.exitCode = 1;
        return;
      }
      process.exitCode = await cmdAutostart(
        state,
        {
          action: action as "enable" | "disable" | "status" | "run",
          taskName: opts.taskName,
          trigger: opts.trigger as "logon" | "startup" | undefined,
          extraArgs: opts.args,
          dryRun: Boolean(opts.dryRun),
        },
        process.argv.slice(3),
      );
    });

  program
    .command("upgrade")
    .description("升级到新版本（备份旧配置 → 迁移 → 切换）")
    .argument("[dir]", "目标版本目录名")
    .option("--to <dir>", "目标版本目录名")
    .option("--carry <mode>", "none | config | all", "config")
    .option("-y, --yes", "不再确认")
    .action(async (dir: string | undefined, opts: { to?: string; carry?: string; yes?: boolean }) => {
      const carry = opts.carry ?? "config";
      if (!["none", "config", "all"].includes(carry)) {
        console.log(red("--carry 只能是 none / config / all"));
        process.exitCode = 1;
        return;
      }
      process.exitCode = await cmdUpgrade(state, {
        to: opts.to ?? dir,
        yes: Boolean(opts.yes),
        carry: carry as "none" | "config" | "all",
      });
    });

  program
    .command("setup")
    .description("主机配置：防火墙 / 页面文件 / Defender / 自启（自动提权）")
    .option("--ports <list>", "要放行的 UDP 端口，逗号分隔", collect)
    .option("--dry-run", "只打印将执行的操作")
    .option("--no-task", "不创建计划任务")
    .option("--no-firewall", "不放行防火墙端口")
    .option("--no-power", "不调整电源计划")
    .option("--no-defender", "不设置 Defender 排除")
    .option("--no-pagefile", "不改页面文件")
    .option("--task-name <name>", "计划任务名")
    .option("--page-init <mb>", "页面文件初始大小")
    .option("--page-max <mb>", "页面文件上限")
    .action(async (opts: Record<string, unknown>) => {
      const ports = Array.isArray(opts.ports)
        ? (opts.ports as string[])
            .flatMap((p) => p.split(","))
            .map((p) => Number(p.trim()))
            .filter((p) => Number.isFinite(p) && p > 0 && p <= 65535)
        : undefined;
      process.exitCode = await cmdSetup(
        state,
        {
          ports,
          dryRun: Boolean(opts.dryRun),
          noTask: opts.task === false,
          noFirewall: opts.firewall === false,
          noPower: opts.power === false,
          noDefender: opts.defender === false,
          noPageFile: opts.pagefile === false,
          taskName: stringOrUndefined(opts.taskName),
          pageFileInitMB: numberOrUndefined(opts.pageInit, "--page-init"),
          pageFileMaxMB: numberOrUndefined(opts.pageMax, "--page-max"),
        },
        process.argv.slice(3),
      );
    });

  program
    .command("settings")
    .description("查看或修改持久启动设置")
    .option("--port <n>")
    .option("--map <stem>")
    .option("--playlist <id>")
    .option("--hostname <name>")
    .option("--password <pw>")
    .option("--visibility <n>")
    .option("--auth <n>")
    .option("--quota-string <n>", "每秒 string 命令上限")
    .option("--quota-script <n>", "每秒脚本命令上限")
    .option("--extra <args>")
    .action(async (opts: Record<string, unknown>) => {
      process.exitCode = await cmdSettings(state, settingsFromOptions(opts));
    });

  program
    .command("console")
    .description("在运行中的实例上执行控制台命令，并报告引擎回执（成功/不存在/用法错误/无回执）")
    .argument("<command...>", "要执行的命令")
    .option("--json", "输出 JSON（command / kind / detail / lines）")
    .option("--wait <ms>", "等待引擎回执的毫秒数", "1200")
    .action(async (command: string[], opts: { json?: boolean; wait?: string }) => {
      process.exitCode = await cmdConsole(state, command, {
        json: Boolean(opts.json),
        waitMs: numberOrUndefined(opts.wait, "--wait"),
      });
    });

  program
    .command("players")
    .description("列出在线玩家（解析 status）")
    .option("--json", "输出 JSON")
    .action(async (opts: { json?: boolean }) => {
      process.exitCode = await cmdPlayers(state, { json: Boolean(opts.json) });
    });

  program
    .command("bots")
    .argument("[action]", "list | add | clear", "list")
    .description("机器人：list 列出 / add 添加（spawnbots、sv_addbot）/ clear 全部踢掉")
    .option("--json", "list 输出 JSON（与 players --json 同构）")
    .option("--count <n>", "添加数量（spawnbots <count>）")
    .option("--name <name>", "具名机器人（sv_addbot <name> <team>）")
    .option("--team <n>", "队伍 0/1/2（配合 --name）")
    .action(async (action: string, opts: { json?: boolean; count?: string; name?: string; team?: string }) => {
      if (action === "list") {
        process.exitCode = await cmdBotsList(state, { json: Boolean(opts.json) });
        return;
      }
      if (action === "add") {
        const team = numberOrUndefined(opts.team, "--team");
        if (team !== undefined && team !== 0 && team !== 1 && team !== 2) {
          console.log(red("--team 只能是 0 / 1 / 2"));
          process.exitCode = 1;
          return;
        }
        process.exitCode = await cmdBotsAdd(state, {
          count: numberOrUndefined(opts.count, "--count"),
          name: stringOrUndefined(opts.name),
          team,
        });
        return;
      }
      if (action === "clear") {
        process.exitCode = await cmdBotsClear(state);
        return;
      }
      console.log(red("用法：r5-server bots <list|add|clear>"));
      process.exitCode = 1;
    });

  program
    .command("kick")
    .description("踢出玩家（userid 或 id64）")
    .argument("<target>", "userid 或 id64")
    .action(async (target: string) => {
      process.exitCode = await cmdModerate(state, "kick", target);
    });

  program
    .command("ban")
    .description("封禁玩家（userid 或 id64；引擎无回执，结果无法确认）")
    .argument("<target>", "userid 或 id64")
    .option("--minutes <n>", "【不支持】时长属 Spire 侧模型，见报错说明")
    .option("--reason <text>", "【不支持】原因属 Spire 侧模型，见报错说明")
    .action(async (target: string, opts: { minutes?: string; reason?: string }) => {
      process.exitCode = await cmdModerate(state, "ban", target, {
        minutes: numberOrUndefined(opts.minutes, "--minutes"),
        reason: stringOrUndefined(opts.reason),
      });
    });

  program
    .command("unban")
    .description("解封（id64）")
    .argument("<target>", "id64")
    .action(async (target: string) => {
      process.exitCode = await cmdModerate(state, "unban", target);
    });

  program
    .command("banlist")
    .description("本地 banlist.json（引擎无回执；--reload 让引擎重新加载名单）")
    .option("--reload", "先发送 banlist_reload")
    .option("--json", "输出 JSON（path / reload / entries）")
    .action(async (opts: { reload?: boolean; json?: boolean }) => {
      process.exitCode = await cmdBanlist(state, {
        reload: Boolean(opts.reload),
        json: Boolean(opts.json),
      });
    });

  program
    .command("announce")
    .description("触发一次轮播公告广播（bridge_chat_announce，引擎无回执）")
    .option("--json", "输出 JSON")
    .action(async (opts: { json?: boolean }) => {
      process.exitCode = await cmdAnnounce(state, { json: Boolean(opts.json) });
    });

  program
    .command("announcements")
    .argument("[action]", "list | add | remove", "list")
    .argument("[index]", "remove 的序号（从 1 起）")
    .description("编辑轮播公告文案（platform/datatable/chat_announcements.csv）")
    .option("--json", "list 输出 JSON")
    .option("--text <text>", "公告正文（≤ 64 字符）")
    .option("--kind <kind>", "rotate | welcome", "rotate")
    .option("--tag <tag>", "前缀标签，例如 [Flowstate]")
    .option("--color <color>", "white|red|gold|green|cyan|rainbow|255 80 80|空")
    .option("--sustain <n>", "完全可见秒数（空 = 8）")
    .option("--fade <n>", "淡出秒数（空 = 2）")
    .option("--wait <n>", "下一条间隔 / 加入后延迟（空 = 60 / 10）")
    .action(async (action: string, index: string | undefined, opts: Record<string, unknown>) => {
      if (action === "list") {
        process.exitCode = await cmdAnnouncements(state, "list", { json: Boolean(opts.json) });
        return;
      }
      if (action === "add") {
        process.exitCode = await cmdAnnouncements(state, "add", {
          row: {
            kind: stringOrUndefined(opts.kind),
            tag: stringOrUndefined(opts.tag),
            text: stringOrUndefined(opts.text),
            color: stringOrUndefined(opts.color),
            sustain: stringOrUndefined(opts.sustain),
            fade: stringOrUndefined(opts.fade),
            wait: stringOrUndefined(opts.wait),
          },
        });
        return;
      }
      if (action === "remove") {
        process.exitCode = await cmdAnnouncements(state, "remove", { index });
        return;
      }
      console.log(red("用法：r5-server announcements <list|add|remove>"));
      process.exitCode = 1;
    });

  program
    .command("mode")
    .argument("[action]", "list | set", "list")
    .argument("[playlist]", "模式 id（set）")
    .argument("[map]", "地图（set，省略时用模式默认地图）")
    .description("模式目录（按家族分组）与运行中热切（bridge_setmode）")
    .option("--json", "list 输出 JSON")
    .action(async (action: string, playlist: string | undefined, map: string | undefined, opts: { json?: boolean }) => {
      if (action === "list") {
        process.exitCode = await cmdModeList(state, { json: Boolean(opts.json) });
        return;
      }
      if (action === "set") {
        process.exitCode = await cmdModeSet(state, playlist ?? "", map);
        return;
      }
      console.log(red("用法：r5-server mode <list|set> [playlist] [map]"));
      process.exitCode = 1;
    });

  program
    .command("health")
    .description("本次运行健康：latest.txt → error / warning / script_warning")
    .option("--json", "输出 JSON")
    .action(async (opts: { json?: boolean }) => {
      process.exitCode = await cmdHealth(state, { json: Boolean(opts.json) });
    });

  program
    .command("doctor")
    .description("环境体检")
    .action(async () => {
      process.exitCode = await cmdDoctor(state);
    });

  program
    .command("tui")
    .description("打开交互式面板")
    .option("--no-follow", "日志不自动跟随")
    .action(async (opts: { follow?: boolean }) => {
      process.exitCode = await tuiLoop(opts.follow !== false);
    });

  // hidden: hosted-console daemon (spawned by `start`)
  program
    .command("__logd", { hidden: true })
    .requiredOption("--out-pipe <path>")
    .requiredOption("--in-pipe <path>")
    .requiredOption("--log <path>")
    .requiredOption("--pid-file <path>")
    .option("--ctl-port <n>", "回环控制端口（0 = 由系统分配）")
    .option("--ctl-token <token>", "控制通道口令")
    .action(
      async (opts: {
        outPipe: string;
        inPipe: string;
        log: string;
        pidFile: string;
        ctlPort?: string;
        ctlToken?: string;
      }) => {
        process.exitCode = await runLogDaemon({
          outPipe: opts.outPipe,
          inPipe: opts.inPipe,
          logFile: opts.log,
          pidFile: opts.pidFile,
          ctlPort: Number.parseInt(opts.ctlPort ?? "0", 10) || 0,
          ctlToken: opts.ctlToken ?? "",
        });
      },
    );

  program.action(async () => {
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      program.help();
      return;
    }
    process.exitCode = await tuiLoop(true);
  });

  return program;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 报错文本里的取值：字符串原样，其余走 JSON 序列化（对象不会被印成 `[object Object]`）。 */
function describeValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "（不可序列化的取值）";
}

function numberOrUndefined(value: unknown, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${flag} 需要数字，收到「${describeValue(value)}」`);
  return n;
}

/** `--visibility` and `--auth` are both 0/1/2 levels. */
function levelOrUndefined(value: unknown, flag: string): 0 | 1 | 2 | undefined {
  const n = numberOrUndefined(value, flag);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < 0 || n > 2) throw new Error(`${flag} 只能是 0 / 1 / 2`);
  return n as 0 | 1 | 2;
}

/** Map CLI flags to raw setting changes; validation lives in settings-fields.ts. */
function settingsFromOptions(opts: Record<string, unknown>): SettingChange[] {
  const raw: { id: FieldId; value: string | undefined }[] = [
    { id: "port", value: stringOrUndefined(opts.port) },
    { id: "map", value: stringOrUndefined(opts.map) },
    { id: "playlist", value: stringOrUndefined(opts.playlist) },
    { id: "hostname", value: stringOrUndefined(opts.hostname) },
    { id: "password", value: stringOrUndefined(opts.password) },
    { id: "visibility", value: stringOrUndefined(opts.visibility) },
    { id: "authMode", value: stringOrUndefined(opts.auth) },
    { id: "quotaString", value: stringOrUndefined(opts.quotaString) },
    { id: "quotaScript", value: stringOrUndefined(opts.quotaScript) },
    { id: "extra", value: stringOrUndefined(opts.extra) },
  ];
  return raw
    .filter((entry): entry is { id: FieldId; value: string } => entry.value !== undefined)
    .map((entry) => ({ id: entry.id, raw: entry.value }));
}

/** Forward a byte stream to `onLine`, one line at a time. */
async function pumpLines(
  stream: ReadableStream<Uint8Array> | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let buffer = "";
  const emit = (text: string): void => {
    const line = stripAnsi(text).replace(/\s+$/, "");
    if (line.length > 0) onLine(line);
  };
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    for (const line of parts) emit(line);
  }
  buffer += decoder.decode();
  emit(buffer);
}

/**
 * Run an action in a child process and stream its output into the dashboard's
 * log pane. The child has no TTY, so `ui.ts` drops colours by itself and the
 * panel keeps the screen.
 */
async function runCaptured(argv: string[], onLine: (line: string) => void): Promise<number> {
  const proc = Bun.spawn({
    cmd: selfCommand(argv),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: process.env,
  });
  await Promise.all([
    pumpLines(proc.stdout as ReadableStream<Uint8Array>, onLine),
    pumpLines(proc.stderr as ReadableStream<Uint8Array>, onLine),
  ]);
  return await proc.exited;
}

/** Dashboard loop: everything happens inside the panel. */
async function tuiLoop(follow: boolean): Promise<number> {
  const app = render(
    React.createElement(Dashboard, {
      initialFollow: follow,
      initialRoute: "main" as Route,
      runCommand: runCaptured,
      applySetting: applySettingInPlace,
    }),
  );
  await app.waitUntilExit();
  return 0;
}

export async function main(): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") return 0;
      if (err.code !== "commander.unknownCommand") process.stderr.write(`${err.message}\n`);
      const code = err.exitCode;
      return typeof code === "number" ? code : Number.parseInt(String(code), 10) || 1;
    }
    // Bad flag value or an unusable terminal: report the message, not a stack.
    if (err instanceof Error) {
      process.stderr.write(`${red(err.message)}\n`);
      return 1;
    }
    throw err;
  }
  const code = process.exitCode;
  return typeof code === "number" ? code : Number.parseInt(String(code ?? 0), 10) || 0;
}

if (import.meta.main) {
  const code = await main();
  closePrompt();
  process.exit(code);
}

export { buildProgram, ROOT };
