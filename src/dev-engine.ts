/**
 * Dev 模式（R5F_DEV=1）的"假 R5F 服务端"：一个本机子进程，顶替真实的 r5apex_ds。
 *
 * 为什么要有它：面板的玩家页、控制台回执、封禁名单、健康页、标题指标全都只能对着
 * 真实引擎验证，而真实引擎只有 Windows 上有。这里复现的是**协议面** —— loopback
 * 控制通道（鉴权 + 回执文本）、`status` 块、标题格式、健康文件、引擎日志 —— 而**不**
 * 复现游戏本体：不绑 UDP、不跑游戏循环、不解释任何脚本、没有网络协议。
 *
 * 三条硬规则：
 *   1. 只在 R5F_DEV=1 时可用；`--version-path` 与 `--log` 必须 realpath 落在 DEV_ROOT
 *      里（真实游戏目录永远不被写），`--ctl-token` 为空直接拒绝（绝不暴露无鉴权端口）。
 *   2. 只复现**实测过**的行为。实测存在的命令（`sv_cheats` 等）回一行"模拟器未实现"，
 *      绝不谎报 `Command 'x' doesn't exist`；没复现的效果也绝不装作成功。
 *   3. 退出必须自己收尾：清定时器、关控制端口、删快照。启动失败同样先把已建的东西拆掉，
 *      不留悬挂进程/端口/文件。
 *
 * 开发专用的控制台命令（只在模拟器里存在，语义见各 handler 注释）：
 *   dev_empty      清空服务器（真人 + 机器人全下线）
 *   dev_fill       填到上限（60 人）
 *   dev_error      往本次运行的 error.log 追加一条**模拟**错误（健康页转红）
 *   dev_recover    清掉那条模拟错误，并复位 dev_disconnect 的丢连接计数
 *   dev_disconnect 让**下一次**控制通道连接被直接断开（面板看到"连接失败"），端口不关
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DEV_MODE, DEV_ROOT } from "./dev";
import {
  DEV_AUTH_ERR,
  DEV_AUTH_OK,
  DEV_PING,
  DEV_PONG,
  DEV_SENT,
  DEV_STOP_ACK,
  DEV_STOP_COMMAND,
  readDevEngineSnapshot,
  removeDevEngineSnapshot,
  writeDevEngineSnapshot,
} from "./dev-protocol";
import { defaultSettings, type Settings } from "./state";
import { isPidAlive } from "./tap";

/** 真机上限 60；机器人另给一个更小的上限，免得面板被机器人刷满。 */
const MAX_PLAYERS = 60;
const MAX_BOTS = 30;
const LOOPBACK = "127.0.0.1";
/** 标题指标刷新周期：面板要看到人数/CPU 在动。 */
const TITLE_REFRESH_MS = 2000;
/** 空闲心跳周期。刚下发过命令就不写：回执判定读的是"水位线之后的新行"，心跳不能混进去。 */
const HEARTBEAT_MS = 30_000;
const HEARTBEAT_QUIET_MS = 15_000;
/** 一行命令的字节上限；超了就回 ERR，不猜。 */
const MAX_COMMAND_BYTES = 2048;
/** dev_disconnect 一次最多丢几个连接。 */
const MAX_DROPS = 10;
/** 同时挂着的控制连接上限（面板 + CLI + 几条在途命令都够用）。 */
const MAX_CLIENTS = 16;
/** 退出码：1 参数/沙箱问题，2 启动失败，3 已有实例。 */
const EXIT_USAGE = 1;
const EXIT_STARTUP = 2;
const EXIT_INSTANCE = 3;
const WARNING_SEED = [
  "Native(S):[DETOUR] installed inline hook (dev simulation placeholder)",
  "Native(S):[FIRE-CLOCK] requested high-resolution clock; falling back to platform default (dev simulation placeholder)",
  "",
].join("\n");
const ERROR_SEED = [
  "[dev-sim] dev_error: synthetic entry — the real engine never writes this",
  "simulate failure: VMaterialSystem: failed to resolve material for level (dev simulation)",
  "",
].join("\n");

export type DevEngineOptions = {
  /** 模拟的版本目录（DEV_ROOT 里的 fixture 目录）。 */
  versionPath: string;
  /** 启动设置；模拟器只用 port/hostname/map/playlist。 */
  settings: Settings;
  /** 引擎日志文件：命令回执就是从这里读回去的（必须落在 DEV_ROOT 里）。 */
  logFile: string;
  /** 控制通道共享密钥；空值直接拒绝。 */
  ctlToken: string;
};

/** 命令行分词结果。`quoted` 是行为的一部分：实测 `kick 1` 无反应、`kick "1"` 生效。 */
type Token = { text: string; quoted: boolean };

type Player = {
  userid: number;
  name: string;
  /** 真人 17 位 id64；机器人是 `0`（面板据此判定 bot）。 */
  uniqueid: string;
  bot: boolean;
  joinedAt: number;
};

/**
 * 模拟封禁条目。真机 `banlist.json` 的字段是引擎侧决定的（面板只做原样呈现），
 * 这份结构是模拟器自造的 —— `simulated` 字段就是标记，别拿它当引擎 schema。
 */
type BanEntry = {
  userid: string;
  name: string;
  id64: string;
  bannedAt: string;
  bannedBy: string;
  simulated: true;
};

/** 路径/参数级失败：带自己的退出码，`runDevEngine` 原样透出。 */
class StartError extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = "StartError";
    this.code = code;
  }
}

function tokenise(line: string): Token[] {
  const tokens: Token[] = [];
  let text = "";
  let quoted = false;
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else text += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (started) tokens.push({ text, quoted });
      text = "";
      quoted = false;
      started = false;
      continue;
    }
    text += ch;
    started = true;
  }
  if (started) tokens.push({ text, quoted });
  return tokens;
}

/** 目标路径必须落在 DEV_ROOT 里（两侧都取 realpath，符号链接绕不过去）。 */
function realWithinRoot(target: string, root: string, label: string, code: number): string {
  let real: string;
  try {
    real = realpathSync(target);
  } catch (err) {
    throw new StartError(`${label} 不可读：${target}（${err instanceof Error ? err.message : String(err)}）`, code);
  }
  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    throw new StartError(`${label} 必须落在 DEV_ROOT（${root}）里，收到 ${real}`, code);
  }
  return real;
}

/** CLI 传进来的 JSON 可能是手工拼的：只用我们真会用的字段，坏值一律回落默认。 */
function coerceSettings(raw: Settings): Settings {
  const source = { ...defaultSettings, ...raw };
  const port = source.port;
  return {
    ...source,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : defaultSettings.port,
    hostname:
      typeof source.hostname === "string" && source.hostname.trim().length > 0
        ? source.hostname
        : defaultSettings.hostname,
    map: typeof source.map === "string" && source.map.trim().length > 0 ? source.map : defaultSettings.map,
    playlist:
      typeof source.playlist === "string" && source.playlist.trim().length > 0
        ? source.playlist
        : defaultSettings.playlist,
  };
}

type Prepared = { versionPath: string; logFile: string; settings: Settings };

/**
 * 启动前置检查：dev 开关、令牌、路径沙箱、以及"是否已经有实例在跑"。
 * 任何一条不过都直接抛 StartError —— 此时一个字节也还没写出去。
 */
function prepare(opts: DevEngineOptions): Prepared {
  if (!DEV_MODE) throw new StartError("模拟引擎只在 R5F_DEV=1 时可用。", EXIT_USAGE);
  if (opts.ctlToken.length === 0)
    throw new StartError("缺少 --ctl-token：模拟实例不接受无鉴权的控制端口。", EXIT_USAGE);
  const root = realWithinRoot(DEV_ROOT, DEV_ROOT, "DEV_ROOT", EXIT_USAGE);
  const versionPath = realWithinRoot(opts.versionPath, root, "--version-path", EXIT_USAGE);
  const declaredLog = resolve(opts.logFile);
  // 不在沙箱里"替调用方建目录"：目录必须已经存在，且 realpath 落在 DEV_ROOT 里。
  // （Main 的启动分支会先 logDir(ROOT) 建好它；这里多一步创建就等于往沙箱外写东西。）
  const logDir = realWithinRoot(dirname(declaredLog), root, "--log 所在目录", EXIT_USAGE);
  const logFile = join(logDir, basename(declaredLog));
  if (existsSync(logFile)) realWithinRoot(logFile, root, "--log", EXIT_USAGE);

  const live = readDevEngineSnapshot();
  if (live && live.pid !== process.pid && isPidAlive(live.pid)) {
    throw new StartError(
      `已有模拟实例在运行（pid ${live.pid}，端口 ${live.port}）：先 r5-server stop，或 r5-server __dev-stop ${live.pid}`,
      EXIT_INSTANCE,
    );
  }
  return { versionPath, logFile, settings: coerceSettings(opts.settings) };
}

class DevEngine {
  private readonly versionPath: string;
  private readonly logFile: string;
  private readonly ctlToken: string;
  private readonly settings: Settings;
  private readonly startedAt = Date.now();
  private readonly runId = randomUUID();
  private readonly players: Player[] = [];
  /** 活着的控制连接：随时增删（每条命令一个短连接），所以用 Set 而不是查表。 */
  private readonly clients = new Set<Socket>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly exited = Promise.withResolvers<number>();
  private readonly banlistFile: string;
  private readonly errorLog: string;
  private banEntries: BanEntry[] = [];
  private server: Server | null = null;
  private ctlPort = 0;
  private frame = 0;
  private nextUserId = 1;
  private botSerial = 0;
  private gameState = "";
  private dropConnections = 0;
  private lastCommandAt = 0;
  private lastHeartbeatAt = 0;
  private snapshotWritten = false;
  private stopping = false;
  private finished = false;
  private snapshotWarned = false;
  private announceEnabled: string;

  constructor(opts: DevEngineOptions, prepared: Prepared) {
    this.versionPath = prepared.versionPath;
    this.settings = prepared.settings;
    this.announceEnabled = this.settings.announceRotate === "on" ? "1" : "0";
    this.logFile = prepared.logFile;
    this.ctlToken = opts.ctlToken;
    this.banlistFile = join(this.versionPath, "banlist.json");
    this.errorLog = join(this.versionPath, "platform", "logs", "server", this.runId, "error.log");
  }

  async run(): Promise<number> {
    try {
      this.prepareFiles();
      await this.listen();
      if (!this.writeSnapshot()) throw new StartError("无法写入模拟实例身份。", EXIT_STARTUP);
      this.snapshotWritten = true;
    } catch (err) {
      this.cleanup();
      process.stderr.write(`dev-engine: ${err instanceof Error ? err.message : String(err)}\n`);
      return err instanceof StartError ? err.code : EXIT_STARTUP;
    }
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => this.finish(0));
    // 契约：就绪之后才说 READY，调用方据此把 ctlPort 写进 runtime。
    process.stdout.write(`READY ${this.ctlPort}\n`);
    this.log(`dev-sim: simulated engine ready (pid ${process.pid}, control port ${this.ctlPort})`);
    this.log(`dev-sim: no real game engine — no UDP ${this.settings.port} bind, no game loop, console protocol only`);
    this.setGameState(this.players.length > 0 ? "Playing" : "WaitingForPlayers");
    this.timers.push(setInterval(() => this.tick(), TITLE_REFRESH_MS));
    const code = await this.exited.promise;
    this.log("dev-sim: engine stopped");
    this.cleanup();
    return code;
  }

  // ------------------------------------------------------------ 启动期文件

  /** 健康文件（面板的体检页读它们）+ 初始玩家 + 本地封禁名单。 */
  private prepareFiles(): void {
    const serverLogDir = join(this.versionPath, "platform", "logs", "server");
    mkdirSync(join(serverLogDir, this.runId), { recursive: true });
    writeFileSync(this.errorLog, "");
    writeFileSync(join(serverLogDir, this.runId, "warning.log"), WARNING_SEED);
    writeFileSync(join(serverLogDir, this.runId, "script_warning.log"), "");
    writeFileSync(join(serverLogDir, "latest.txt"), `${this.runId}\n`);
    this.reloadBanlist();
    this.addPlayer("dev-human-1");
    this.addPlayer("dev-human-2");
    this.addBot();
  }

  private async listen(): Promise<void> {
    const server = createServer((client: Socket) => this.accept(client));
    this.server = server;
    const bound = Promise.withResolvers<void>();
    server.once("error", bound.reject);
    server.listen(0, LOOPBACK, () => bound.resolve());
    await bound.promise;
    const address = server.address();
    if (address === null || typeof address === "string") throw new StartError("控制端口没有绑定成功。", EXIT_STARTUP);
    this.ctlPort = address.port;
  }

  private cleanup(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    this.server?.close();
    this.server = null;
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    // 只删自己写的快照：别人的实例还在跑时，删掉它等于把它的身份弄丢。
    if (this.snapshotWritten) removeDevEngineSnapshot();
  }

  // --------------------------------------------------------------- 控制通道

  /**
   * 一条连接 = 先 `AUTH <token>`，之后一行一条命令，每条命令回一行。
   * `dev_disconnect` 布下的丢连接计数在这里消费：直接断，不回任何东西。
   */
  private accept(client: Socket): void {
    if (this.stopping || this.clients.size >= MAX_CLIENTS) {
      client.destroy();
      return;
    }
    if (this.dropConnections > 0) {
      this.dropConnections -= 1;
      client.destroy();
      return;
    }
    this.clients.add(client);
    let buffer = "";
    let authorised = false;
    let authFailures = 0;
    client.on("error", () => {
      /* 客户端随时会走人 */
    });
    client.on("close", () => this.clients.delete(client));
    client.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          if (buffer.length > MAX_COMMAND_BYTES) buffer = "";
          break;
        }
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!authorised) {
          authorised = line.trim() === `AUTH ${this.ctlToken}`;
          client.write(authorised ? `${DEV_AUTH_OK}\n` : `${DEV_AUTH_ERR}\n`);
          if (!authorised) {
            authFailures += 1;
            if (authFailures >= 3) client.destroy();
          }
          continue;
        }
        const command = line.trim();
        if (command.length === 0) continue;
        if (command === DEV_PING) {
          client.write(`${DEV_PONG}\n`);
          continue;
        }
        if (command.length > MAX_COMMAND_BYTES) {
          client.write("ERR command too long\n");
          continue;
        }
        if (command === DEV_STOP_COMMAND) {
          // 先确认再收尾：调用方就是靠"确认 + 连接断开"判定停成功的。
          // 确认必须真的写出去（写回调 = 已交给内核），否则收尾时的 destroy 会把它吞掉，
          // 调用方只会看到"连接断了但没有回执"，判定为失败。
          this.stopping = true;
          client.write(`${DEV_STOP_ACK}\n`, () => this.finish(0));
          setTimeout(() => this.finish(0), 250); // 对端已经消失时回调不会来，兜底
          continue;
        }
        this.handleCommand(command);
        client.write(`${DEV_SENT}\n`);
      }
    });
  }

  // ----------------------------------------------------------------- 命令

  private handleCommand(line: string): void {
    const tokens = tokenise(line);
    const head = tokens[0];
    if (head === undefined) return;
    const name = head.text.toLowerCase();
    const args = tokens.slice(1);
    this.lastCommandAt = Date.now();
    switch (name) {
      case "status":
        this.printStatus();
        return;
      case "kick":
        this.kick(args[0]);
        return;
      case "ban":
        this.addBan(args[0]?.text ?? "");
        return;
      case "unban":
        this.liftBan(args[0]?.text ?? "");
        return;
      case "banlist_reload":
        // 实测静默（命令存在、一个字都不回）：一个字都不回才算忠实。
        this.reloadBanlist();
        return;
      case "spawnbots":
        this.spawnBots(args[0]?.text ?? "");
        return;
      case "sv_addbot":
        this.addBotCommand(args);
        return;
      case "bridge_setmode":
        this.setMode(args);
        return;
      case "changelevel":
        this.changeLevel(args[0]?.text ?? "");
        return;
      case "bridge_chat_announce":
        if (args[0]) {
          if (args[0].text !== "0" && args[0].text !== "1") {
            this.log("Usage: bridge_chat_announce <0|1>");
            return;
          }
          this.announceEnabled = args[0].text;
        }
        return;
      case "playlist_override_list":
        // 实测静默：命令存在但无输出。
        return;
      case "playlist_override_set":
        if (args.length < 2) {
          this.log("usage: playlist_override_set <var> <value>");
          return;
        }
        break;
      case "help":
        if (args.length === 0) {
          this.log("Usage:  help <cvarname>");
          return;
        }
        if (args[0]?.text === "bridge_chat_announce") {
          this.log(`"bridge_chat_announce" = "${this.announceEnabled}" ( def. "0" )`);
        } else {
          this.log(`help: no cvar or command named ${args[0]?.text ?? ""}`);
        }
        return;
      case "dev_empty":
        this.devEmpty();
        return;
      case "dev_fill":
        this.devFill();
        return;
      case "dev_error":
        this.devError();
        return;
      case "dev_recover":
        this.devRecover();
        return;
      case "dev_disconnect":
        this.devDisconnect(args[0]?.text ?? "");
        return;
      default:
        this.unknownCommand(name);
        return;
    }
    this.notSimulated(name);
  }

  /** 实测格式：`Command 'x' doesn't exist; request 'x' ignored`。 */
  private unknownCommand(name: string): void {
    this.log(`Command '${name}' doesn't exist; request '${name}' ignored`);
  }

  /** 实测存在、本模拟器不复现的命令：如实说明，不谎报不存在，也不假装成功。 */
  private notSimulated(name: string): void {
    this.log(`dev-sim: '${name}' exists on the real engine but this simulated engine does not implement it`);
  }

  private printStatus(): void {
    const lines = [
      `hostname: ${this.settings.hostname}`,
      `version : ${basename(this.versionPath)} (simulated)`,
      `udp/ip  : ${LOOPBACK}:${this.settings.port} (dev simulation, not bound)`,
      `os/type : ${process.platform}-dev-sim`,
      `players : ${this.humans()} humans, ${this.botCount()} bots (${MAX_PLAYERS} max)`,
      `map     : ${this.settings.map} at (0, 0, 0)`,
      `game    : ${this.settings.playlist}`,
      "# userid name uniqueid connected ping loss state rate",
    ];
    for (const player of this.players) {
      lines.push(
        `# ${player.userid} "${player.name}" ${player.uniqueid} ${this.connectedClock(player)} ${this.pingOf(player)} 0 active 256000`,
      );
    }
    lines.push("#end");
    this.log(lines.join("\n"));
  }

  /**
   * 踢人。实测（ticket 01/03，r5f-dedi 1.0.13）：
   *   `kick "1"` → `Kicked '1' from server`（回显的是传进去的那个目标）
   *   `kick 1`（不带引号）→ 无任何反应，也不生效
   *   对机器人 `kick "<userid>"` → 静默且不生效；`kick "<名字>"` 才生效
   * 目标不存在时没有实测先例 → 静默、不动任何东西（宁可说"没回执"，也不假装踢掉了）。
   */
  private kick(token: Token | undefined): void {
    if (token === undefined || !token.quoted || token.text.length === 0) return;
    const player = this.findPlayer(token.text);
    if (player === undefined) return;
    if (player.bot && token.text.toLowerCase() !== player.name.toLowerCase()) return;
    this.players.splice(this.players.indexOf(player), 1);
    this.log(`Kicked '${token.text}' from server`);
    if (this.players.length === 0) this.setGameState("WaitingForPlayers");
    this.writeSnapshot();
  }

  /**
   * 封禁：实测**静默**（`ban "1"` 一个字都不回）。
   *
   * 落盘的是本地模拟名单（真机 schema 未知，面板只做原样呈现）：`<版本目录>/banlist.json`
   * 正是 `r5-server banlist` 的第一个候选路径，所以面板能看到它。是否顺带把玩家踢下线
   * 属于**未实测**的效果 —— 这里不假装，只记名单。
   */
  private addBan(target: string): void {
    const trimmed = target.trim();
    if (trimmed.length === 0) return;
    const player = this.findPlayer(trimmed);
    if (player?.bot === true) return; // 机器人不会被封禁（面板文案如此）
    // 目标不是在线玩家时，按"像 id64 就是 id64"记：17 位数字是引擎侧的 id64 形状。
    const asId64 = /^\d{17}$/.test(trimmed);
    const entry: BanEntry = {
      userid: player ? String(player.userid) : asId64 ? "" : trimmed,
      name: player?.name ?? "",
      id64: player ? player.uniqueid : asId64 ? trimmed : "",
      bannedAt: new Date().toISOString(),
      bannedBy: "console",
      simulated: true,
    };
    this.banEntries = this.banEntries.filter(
      (existing) => existing.id64 !== entry.id64 && existing.userid !== entry.userid,
    );
    this.banEntries.push(entry);
    this.saveBanlist();
  }

  private liftBan(target: string): void {
    const trimmed = target.trim();
    if (trimmed.length === 0) return;
    const lower = trimmed.toLowerCase();
    const kept = this.banEntries.filter(
      (entry) => entry.id64 !== trimmed && entry.userid !== trimmed && entry.name.toLowerCase() !== lower,
    );
    if (kept.length === this.banEntries.length) return;
    this.banEntries = kept;
    this.saveBanlist();
  }

  /**
   * 造机器人。实测：无参回 `Spawn fake players. Usage: spawnbots <count>`；
   * `spawnbots 0` 仍然生成了 1 个（bot0）→ 这里把 <1 一律按 1 处理。
   * 上限是模拟器自己的（MAX_BOTS），到顶就明说生成了几个，不假装生成了请求的数量。
   */
  private spawnBots(text: string): void {
    const count = Number.parseInt(text, 10);
    if (text.length === 0 || Number.isNaN(count)) {
      this.log("Spawn fake players. Usage: spawnbots <count>");
      return;
    }
    let added = 0;
    for (let i = 0; i < Math.max(1, count); i += 1) {
      if (!this.addBot()) break;
      added += 1;
    }
    this.log(`Spawned ${added} fake player(s) (${this.botCount()} bots, ${this.players.length} players)`);
    this.writeSnapshot();
  }

  /** `sv_addbot <name> <teamid>`：实测无参回 `usage 'sv_addbot': name(string) teamid(int)`。 */
  private addBotCommand(args: Token[]): void {
    const name = args[0]?.text ?? "";
    const team = args[1]?.text ?? "";
    if (name.length === 0 || team.length === 0 || !/^\d+$/.test(team)) {
      this.log("usage 'sv_addbot': name(string) teamid(int)");
      return;
    }
    if (!this.addBot(name)) {
      this.log(`sv_addbot: rejected — bot capacity reached (${MAX_BOTS} bots, ${MAX_PLAYERS} players)`);
      return;
    }
    this.log(`Added bot '${name}' (${this.botCount()} bots, ${this.players.length} players)`);
    this.writeSnapshot();
  }

  /** 实测用法：`bridge_setmode <playlist> <map>`（一步热切模式 + 地图）。 */
  private setMode(args: Token[]): void {
    const playlist = args[0]?.text ?? "";
    const map = args[1]?.text ?? "";
    if (playlist.length === 0 || map.length === 0) {
      this.log("Usage: bridge_setmode <playlist> <map>");
      return;
    }
    this.settings.playlist = playlist;
    this.changeLevel(map);
  }

  private changeLevel(map: string): void {
    if (map.length === 0) {
      this.log("Usage: changelevel <map>");
      return;
    }
    this.settings.map = map;
    this.setGameState("Loading");
    this.log(`Loaded playlist ${this.settings.playlist} on ${map}`);
    this.log(`Starting server with name: "${this.settings.hostname}" map: "${map}" mode: "${this.settings.playlist}"`);
    this.setGameState(this.players.length > 0 ? "Playing" : "WaitingForPlayers");
    this.writeSnapshot();
  }

  // ------------------------------------------------------- dev 专用命令

  /** `dev_empty`：真人 + 机器人全部下线，用来验证"当前没有玩家在线"的空态。 */
  private devEmpty(): void {
    const removed = this.players.length;
    this.players.length = 0;
    this.setGameState("WaitingForPlayers");
    this.log(`dev-sim: dev_empty -> removed ${removed} players; server is empty`);
    this.writeSnapshot();
  }

  /** `dev_fill`：填到真机上限（60 人），用来验证满员时的显示。 */
  private devFill(): void {
    let added = 0;
    while (this.players.length < MAX_PLAYERS && this.addPlayer(`dev-human-${this.nextUserId}`)) added += 1;
    this.log(`dev-sim: dev_fill -> added ${added} simulated humans; ${this.players.length}/${MAX_PLAYERS} players`);
    this.writeSnapshot();
  }

  /** `dev_error`：往本次运行的 error.log 追加一条模拟错误（体检页因此转红）。 */
  private devError(): void {
    appendFileSync(this.errorLog, ERROR_SEED, "utf8");
    this.log(`dev-sim: dev_error -> appended a synthetic entry to ${this.errorLog}`);
  }

  /** `dev_recover`：清掉模拟错误，并复位 `dev_disconnect` 留下的丢连接计数。 */
  private devRecover(): void {
    writeFileSync(this.errorLog, "");
    this.dropConnections = 0;
    this.log(`dev-sim: dev_recover -> cleared ${this.errorLog} and reset the drop counter`);
  }

  /**
   * `dev_disconnect`：让接下来 N 次（默认 1 次）控制通道连接被**立刻断开**，面板/CLI
   * 会看到"控制通道连接失败"。监听端口不受影响 —— 下一次连接就能恢复，`__dev_stop`
   * 也仍然走得通（`requestDevStop` 会在预算内重试一次）。
   */
  private devDisconnect(text: string): void {
    if (text.length > 0) {
      const parsed = Number.parseInt(text, 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > MAX_DROPS) {
        this.log(`Usage: dev_disconnect [count] (1-${MAX_DROPS})`);
        return;
      }
      this.dropConnections = parsed;
    } else {
      this.dropConnections = 1;
    }
    this.log(`dev-sim: dev_disconnect -> the next ${this.dropConnections} control connection(s) will be dropped`);
  }

  // ------------------------------------------------------------- 玩家表

  private humans(): number {
    return this.players.length - this.botCount();
  }

  private botCount(): number {
    let count = 0;
    for (const player of this.players) if (player.bot) count += 1;
    return count;
  }

  /** userid / id64 / 名字都能命中（面板与 CLI 就是这么传的）。 */
  private findPlayer(token: string): Player | undefined {
    const lower = token.toLowerCase();
    return this.players.find(
      (player) => String(player.userid) === token || player.uniqueid === token || player.name.toLowerCase() === lower,
    );
  }

  private addPlayer(name: string): boolean {
    if (this.players.length >= MAX_PLAYERS) return false;
    const userid = this.nextUserId;
    this.nextUserId += 1;
    this.players.push({
      userid,
      name,
      uniqueid: `76561198${String(userid).padStart(9, "0")}`,
      bot: false,
      joinedAt: this.startedAt,
    });
    if (this.gameState !== "Playing") this.setGameState("Playing");
    return true;
  }

  private addBot(name?: string): boolean {
    if (this.botCount() >= MAX_BOTS || this.players.length >= MAX_PLAYERS) return false;
    const userid = this.nextUserId;
    this.nextUserId += 1;
    this.players.push({
      userid,
      name: name ?? `bot${this.botSerial}`,
      uniqueid: "0",
      bot: true,
      joinedAt: this.startedAt,
    });
    if (name === undefined) this.botSerial += 1;
    if (this.gameState !== "Playing") this.setGameState("Playing");
    return true;
  }

  /** 状态机取值与真机日志同一套词（面板读 `Setting game state to:` 那行）。 */
  private setGameState(state: string): void {
    if (this.gameState === state) return;
    this.gameState = state;
    this.log(`Setting game state to: ${state}`);
  }

  private connectedClock(player: Player): string {
    const seconds = Math.max(0, Math.floor((Date.now() - player.joinedAt) / 1000));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  /** 确定性 ping：同一个 userid 永远同一个值，面板截图/断言不会飘。 */
  private pingOf(player: Player): number {
    return 10 + ((player.userid * 7) % 40);
  }

  // --------------------------------------------------------- 名单与指标

  private reloadBanlist(): void {
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(this.banlistFile, "utf8")) as unknown;
    } catch {
      raw = null; // 文件不存在或不是 JSON：当成空名单
    }
    // 名单文件的形状由引擎决定，我们不知道：数组与 `{entries: […]}` 都吃。
    const list = Array.isArray(raw) ? raw : (raw as { entries?: unknown } | null)?.entries;
    this.banEntries = Array.isArray(list)
      ? list.filter((entry): entry is BanEntry => {
          if (typeof entry !== "object" || entry === null) return false;
          const value = entry as Record<string, unknown>;
          return (
            typeof value.userid === "string" &&
            typeof value.id64 === "string" &&
            typeof value.name === "string" &&
            typeof value.bannedAt === "string" &&
            value.bannedBy === "console" &&
            value.simulated === true
          );
        })
      : [];
  }

  private saveBanlist(): void {
    try {
      writeFileSync(this.banlistFile, `${JSON.stringify(this.banEntries, null, 2)}\n`, "utf8");
    } catch (err) {
      // 写不进去就明说（回执窗口里多一行，总比悄悄吞掉强）。
      this.log(`dev-sim: banlist write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 真机标题形状：`NAME - 0/60 Players (playlist on map) - 6% Server CPU (50.001 msec on frame 1413)`。 */
  private title(): string {
    const players = this.players.length;
    const humans = this.humans();
    const bots = this.botCount();
    const cpu = (2 + humans * 1.1 + bots * 0.35).toFixed(1);
    const frameMs = (16 + players * 0.35).toFixed(3);
    return `${this.settings.hostname} - ${players}/${MAX_PLAYERS} Players (${this.settings.playlist} on ${this.settings.map}) - ${cpu}% Server CPU (${frameMs} msec on frame ${this.frame})`;
  }

  private writeSnapshot(): boolean {
    try {
      writeDevEngineSnapshot({
        pid: process.pid,
        port: this.settings.port,
        versionPath: this.versionPath,
        startedAt: new Date(this.startedAt).toISOString(),
        title: this.title(),
      });
      return true;
    } catch (err) {
      if (this.snapshotWarned) return false;
      this.snapshotWarned = true;
      process.stderr.write(`dev-engine: 快照写入失败：${err instanceof Error ? err.message : String(err)}\n`);
      return false;
    }
  }

  private tick(): void {
    if (this.stopping) return;
    this.frame += 60;
    this.writeSnapshot();
    if (Date.now() - this.lastCommandAt < HEARTBEAT_QUIET_MS) return;
    if (Date.now() - this.lastHeartbeatAt < HEARTBEAT_MS) return;
    this.lastHeartbeatAt = Date.now();
    this.log(
      `Native(S): Frame ${this.frame} - ${this.humans()} humans, ${this.botCount()} bots, game state ${this.gameState}`,
    );
  }

  // ------------------------------------------------------------- 退出

  private finish(code: number): void {
    if (this.finished) return;
    this.finished = true;
    this.stopping = true;
    this.exited.resolve(code);
  }

  /** 日志行：`[运行秒.毫秒] 正文`，与真机日志同形（回执分类器会剥掉这个前缀）。 */
  private log(text: string): void {
    const stamp = ((Date.now() - this.startedAt) / 1000).toFixed(3);
    try {
      appendFileSync(this.logFile, `[${stamp}] ${text}\n`, "utf8");
    } catch (err) {
      process.stderr.write(`dev-engine: 日志写入失败：${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

/**
 * 起一个模拟引擎，直到它停下来为止。返回值就是进程退出码。
 *
 * 调用方（隐藏的 `__dev-engine` 命令）只需要：spawn 它 → 等到 stdout 上出现
 * `READY <ctlPort>` → 把 pid/端口/令牌写进 state.runtime。
 */
export async function runDevEngine(opts: DevEngineOptions): Promise<number> {
  try {
    return await new DevEngine(opts, prepare(opts)).run();
  } catch (err) {
    process.stderr.write(`dev-engine: ${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof StartError ? err.code : EXIT_STARTUP;
  }
}
