import type {
  AnnouncementsFile,
  Capability,
  Catalog,
  Health,
  HostFacts,
  InstanceMetrics,
  LogReader,
  LogShardView,
  ModeFamily,
  ModerationResult,
  PlayerRow,
  ProfileRow,
  Receipt,
  Settings,
  StartOptions,
  StartOutcome,
  State,
  VersionInfo,
} from "@server/panel";
import * as api from "@server/panel";
import type { FieldId } from "@server/settings-fields";
import { selfCommand } from "@server/tap";
/**
 * 面板的会话状态：一份进程内单例，装着从磁盘与运行实例读来的数据，以及改动它们的动作。
 *
 * 取数分两档：
 *  - **快**（1.5 s）：实例进程指标、日志增量、玩家列表 —— 都是面板要"实时"的东西；
 *  - **慢**（按需）：主机体检、本次运行健康、版本目录体积 —— 每次要跑 PowerShell 或扫盘。
 *
 * 所有写操作都走 `src/panel.ts`（= CLI 同一套实现），成功/失败都落成一条 `notice`，
 * 界面只负责把 notice 显示出来，不各自编话术。
 */
import { createSignal } from "@solid-gpui/core/runtime";

export type NoticeKind = "info" | "success" | "warning" | "error";
export type Notice = { id: number; kind: NoticeKind; title: string; detail?: string; at: number };

export type ConsoleEntry = { id: number; line: string; kind: NoticeKind; text: string; at: number };

const FAST_INTERVAL = 1500;
const SLOW_INTERVAL = 30_000;

let noticeSeq = 1;
let consoleSeq = 1;

/** 本机封禁台账（`moderation.json`）：时长/原因/到期只有这里有，引擎不保存。 */
function readLedger(): ReturnType<typeof api.moderationLedger> {
  return api.moderationLedger();
}

/** 回执分类的中文结论：引擎只回原文，结论由我们按四类给。 */
function receiptLabelOf(receipt: Receipt): string {
  switch (receipt.kind) {
    case "success":
      return "引擎确认执行";
    case "unknown":
      return "引擎不认识这条命令";
    case "usage":
      return "参数用法不对";
    default:
      return "命令已发出（引擎无回执）";
  }
}

export type Session = ReturnType<typeof createSession>;

function createSession() {
  const [state, setState] = createSignal<State>(api.loadState());
  const [versions, setVersions] = createSignal<VersionInfo[]>([]);
  const [instance, setInstance] = createSignal<InstanceMetrics | null>(null);
  const [players, setPlayers] = createSignal<PlayerRow[]>([]);
  const [playersError, setPlayersError] = createSignal<string | null>(null);
  const [catalog, setCatalog] = createSignal<Catalog>({ maps: [], playlists: [], modes: [] });
  const [families, setFamilies] = createSignal<ModeFamily[]>([]);
  const [health, setHealth] = createSignal<Health | null>(null);
  const [host, setHost] = createSignal<HostFacts | null>(null);
  const [capabilities, setCapabilities] = createSignal<Capability[]>([]);
  const [shards, setShards] = createSignal<LogShardView[]>([]);
  const [notices, setNotices] = createSignal<Notice[]>([]);
  const [consoleLog, setConsoleLog] = createSignal<ConsoleEntry[]>([]);
  const [busy, setBusy] = createSignal<string | null>(null);

  let reader: LogReader = api.createLogReader(null, 0);
  const [logLines, setLogLines] = createSignal<string[]>([]);
  const [logPath, setLogPath] = createSignal<string | null>(null);
  const [following, setFollowing] = createSignal(true);

  let fastTimer: ReturnType<typeof setInterval> | undefined;
  let slowTimer: ReturnType<typeof setInterval> | undefined;
  let slowBusy = false;

  function notice(kind: NoticeKind, title: string, detail?: string): void {
    const entry: Notice = { id: noticeSeq++, kind, title, detail, at: Date.now() };
    setNotices((list) => [entry, ...list].slice(0, 40));
  }

  function dismiss(id: number): void {
    setNotices((list) => list.filter((entry) => entry.id !== id));
  }

  function clearNotices(): void {
    setNotices([]);
  }

  /** 动作成功/失败的统一出口：把 panel 抛的错也变成一条 notice，界面不必写 try/catch。 */
  async function run<T>(label: string, action: () => T | Promise<T>): Promise<T | undefined> {
    setBusy(label);
    try {
      return await action();
    } catch (err) {
      notice("error", label, err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  /** 日志读取器跟着当前运行实例走：实例换了就重新读尾部，不混两段日志。 */
  function bindLogReader(path: string | null): void {
    if (reader.path === path) return;
    reader = api.createLogReader(path, 400);
    setLogPath(path);
    setLogLines([...reader.lines]);
  }

  function pollLog(): void {
    const fresh = reader.poll();
    if (fresh.length === 0) return;
    setLogLines((lines) => {
      const next = [...lines, ...fresh];
      return next.length > 5000 ? next.slice(next.length - 5000) : next;
    });
  }

  async function refreshState(): Promise<void> {
    const next = api.loadState();
    setState(next);
    bindLogReader(next.runtime?.logFile ?? null);
    setShards(api.listRunShards(next));
  }

  async function refreshFast(): Promise<void> {
    const current = state();
    const metrics = await api.collectInstance(current);
    setInstance(metrics);
    bindLogReader(current.runtime?.logFile ?? null);
    pollLog();
    if (metrics?.hosted) {
      const result = await api.listPlayers(current);
      setPlayers(result.players);
      setPlayersError(result.error ?? null);
    } else {
      setPlayers([]);
      setPlayersError(metrics ? "实例不是以托管控制台启动的，读不到玩家列表" : null);
    }
  }

  function refreshVersions(withSizes = false): void {
    setVersions(api.listVersions(withSizes));
  }

  function refreshCatalog(): void {
    const current = state();
    setCatalog(api.currentCatalog(current));
    void api.modeFamilies(current).then(setFamilies);
    setShards(api.listRunShards(current));
  }

  async function refreshSlow(force = false): Promise<void> {
    if (slowBusy && !force) return;
    slowBusy = true;
    try {
      const current = state();
      const [nextHealth, nextHost, nextCaps] = await Promise.all([
        api.health(current),
        api.hostFacts(current),
        api.capabilities(current),
      ]);
      setHealth(nextHealth);
      setHost(nextHost);
      setCapabilities(nextCaps);
    } catch (err) {
      notice("warning", "主机体检失败", err instanceof Error ? err.message : String(err));
    } finally {
      slowBusy = false;
    }
  }

  function start(): void {
    refreshVersions();
    refreshCatalog();
    void refreshState();
    void refreshFast();
    void refreshSlow();
    fastTimer = setInterval(() => void refreshFast(), FAST_INTERVAL);
    slowTimer = setInterval(() => void refreshSlow(), SLOW_INTERVAL);
  }

  function dispose(): void {
    if (fastTimer !== undefined) clearInterval(fastTimer);
    if (slowTimer !== undefined) clearInterval(slowTimer);
    fastTimer = undefined;
    slowTimer = undefined;
  }

  // ---------------------------------------------------------------- 动作

  /** 启动实例，并把结果落成 notice + 控制台回显。 */
  async function startServer(opts: StartOptions = {}): Promise<StartOutcome | undefined> {
    const result = await run("启动服务器", () => api.launchInstance(state(), opts));
    if (!result) return undefined;
    if (!result.ok) {
      notice("error", "启动失败", result.hint ? `${result.error}　${result.hint}` : result.error);
      return result;
    }
    for (const warning of result.warnings) notice("warning", "启动提示", warning);
    notice(
      "success",
      `已启动 ${result.version}`,
      `端口 ${result.port}${result.hosted ? " · 日志已接上，面板会跟着记" : ""}`,
    );
    await refreshState();
    await refreshFast();
    return result;
  }

  async function stopServer(all = false): Promise<void> {
    // `killInstance` 停不下来时**抛错**（实例记录保留，可以重试），`run` 会把它变成一条
    // error notice —— 这种情况下不能再补一句「已停止」，否则界面上会同时出现互相矛盾的两条。
    const result = await run("停止服务器", () => api.killInstance(state(), all));
    if (result === undefined) return;
    // 与 CLI 的 `cmdStop` 同一套话术：0 个 = 本来就没在跑。
    notice("info", result > 0 ? `已停止 ${result} 个进程` : "没有正在运行的实例");
    await refreshState();
    await refreshFast();
  }

  async function restartServer(opts: StartOptions = {}): Promise<void> {
    notice("info", "正在重启…", "按当前配置重新启动，正在玩的玩家会掉线");
    const result = await run("重启服务器", () => api.restartInstance(state(), opts));
    if (result?.ok) notice("success", "已重启", `端口 ${result.port}`);
    else if (result) notice("error", "重启失败", result.error);
    await refreshState();
    await refreshFast();
  }

  function useVersion(name: string): void {
    void run("切换版本", () => {
      const target = api.useVersion(state(), name);
      if (!target) throw new Error(`找不到版本目录「${name}」`);
      notice("success", `当前版本 → ${target.name}`);
      refreshCatalog();
      void refreshState();
      return target;
    });
  }

  /** 发一条控制台命令：回执分类文案直接进控制台面板，也留一条 notice。 */
  async function console(line: string): Promise<Receipt | undefined> {
    const trimmed = line.trim();
    if (trimmed.length === 0) return undefined;
    const result = await run(`控制台 ${trimmed}`, () => api.sendConsole(state(), trimmed));
    if (result === undefined) return undefined;
    if (result === "no-control") {
      const entry: ConsoleEntry = {
        id: consoleSeq++,
        line: trimmed,
        kind: "error",
        text: api.NO_CONTROL_MESSAGE,
        at: Date.now(),
      };
      setConsoleLog((list) => [entry, ...list].slice(0, 200));
      notice("error", "没有控制通道", api.NO_CONTROL_MESSAGE);
      return undefined;
    }
    const kind: NoticeKind = result.kind === "success" ? "success" : result.kind === "silent" ? "info" : "error";
    const text = `${receiptLabelOf(result)}${result.detail ? ` — ${result.detail}` : ""}`;
    const entry: ConsoleEntry = { id: consoleSeq++, line: trimmed, kind, text, at: Date.now() };
    setConsoleLog((list) => [entry, ...list].slice(0, 200));
    pollLog();
    return result;
  }

  async function moderate(
    action: "kick" | "ban" | "unban",
    target: string,
    opts: { minutes?: number; reason?: string } = {},
  ): Promise<ModerationResult | "no-control" | undefined> {
    const label = action === "kick" ? "踢出玩家" : action === "ban" ? "封禁玩家" : "解除封禁";
    const result = await run(label, () => api.moderatePlayer(state(), action, target, opts));
    if (result === undefined) return undefined;
    if (result === "no-control") {
      notice("error", label, api.NO_CONTROL_MESSAGE);
      return result;
    }
    notice(result.receipt.kind === "success" ? "success" : "warning", label, result.label);
    await refreshFast();
    return result;
  }

  async function addBots(opts: { count?: number; name?: string; team?: 0 | 1 | 2 }): Promise<void> {
    const result = await run("添加机器人", () => api.botsAdd(state(), opts));
    if (result === undefined) return;
    if (result === "no-control") {
      notice("error", "添加机器人", api.NO_CONTROL_MESSAGE);
      return;
    }
    if (!result.ok) {
      notice("error", "添加机器人", result.hint ? `${result.error}　${result.hint}` : result.error);
      return;
    }
    notice(result.receipt.kind === "success" ? "success" : "warning", "添加机器人", `${result.line} — ${result.label}`);
    await refreshFast();
  }

  async function clearBots(): Promise<void> {
    const result = await run("清空机器人", () => api.botsClear(state()));
    if (result === undefined) return;
    if (result === "no-control") {
      notice("error", "清空机器人", api.NO_CONTROL_MESSAGE);
      return;
    }
    if (!result.ok) {
      notice("error", "清空机器人", result.error);
      return;
    }
    notice(
      result.remaining === 0 ? "success" : "warning",
      "清空机器人",
      `已清理 ${Math.max(0, result.before - result.remaining)} 个，剩余 ${result.remaining}`,
    );
    await refreshFast();
  }

  async function switchMode(playlist: string, map?: string): Promise<void> {
    const result = await run("切换模式", () => api.setLiveMode(state(), playlist, map));
    if (result === undefined) return;
    if (result === "no-control") {
      notice("error", "切换模式", api.NO_CONTROL_MESSAGE);
      return;
    }
    if (!result.ok) {
      notice("error", "切换模式", result.error);
      return;
    }
    notice(result.receipt.kind === "success" ? "success" : "warning", "切换模式", `${result.playlist} · ${result.map}`);
    await refreshState();
  }

  async function broadcast(): Promise<void> {
    const result = await run("广播公告", () => api.broadcastAnnouncements(state()));
    if (result === "no-control") {
      notice("error", "广播公告", api.NO_CONTROL_MESSAGE);
      return;
    }
    if (!result) return;
    notice("info", "广播公告", "已经发出。服务器对这条不回话，效果要有人在游戏里确认。");
  }

  async function saveAnnouncements(rows: Parameters<typeof api.saveAnnouncements>[1]): Promise<boolean> {
    const result = await run("保存公告", () => api.saveAnnouncements(state(), rows));
    if (!result) return false;
    if (!result.ok) {
      notice("error", "保存公告", result.error);
      return false;
    }
    notice("success", "公告已保存", `${result.rows} 条 · 换图或重启后生效`);
    return true;
  }

  /** 改设置：成功/失败逐条落 notice。 */
  async function saveSettings(changes: { id: FieldId; raw: string }[]): Promise<boolean> {
    const result = await run("保存设置", () => api.updateSettings(state(), changes));
    if (!result) return false;
    for (const line of result.applied) notice("success", "已保存", line);
    for (const line of result.failed) notice("error", "未保存", line);
    await refreshState();
    return result.failed.length === 0;
  }

  async function resetSetting(id: FieldId): Promise<void> {
    const result = await run("恢复默认", () => api.resetField(state(), id));
    if (!result) return;
    for (const line of result.applied) notice("success", "已恢复默认", line);
    await refreshState();
  }

  async function activateProfile(name: string): Promise<void> {
    const ok = api.activateProfile(state(), name);
    if (!ok) {
      notice("error", "启用配置", `找不到档案「${name}」`);
      return;
    }
    notice("success", "已切换配置", name);
    await refreshState();
  }

  async function writeProfile(action: "create" | "overwrite" | "delete", name: string): Promise<boolean> {
    const result = await run("配置档案", () => {
      if (action === "create") return api.createProfile(state(), name);
      if (action === "overwrite") return api.overwriteProfile(state(), name);
      return api.deleteProfile(state(), name);
    });
    if (!result) return false;
    if (!result.ok) {
      notice("error", "配置档案", result.error);
      return false;
    }
    notice("success", "配置档案", `${action === "delete" ? "已删除" : "已保存"} ${result.name}`);
    await refreshState();
    return true;
  }

  /** 打开（或换到）某个日志分片；`follow` 为真时继续吃增量。 */
  function openShard(path: string | null): void {
    reader = api.createLogReader(path, 2000);
    setLogPath(path);
    setLogLines([...reader.lines]);
  }

  async function loadAnnouncements(): Promise<AnnouncementsFile | null> {
    return api.loadAnnouncements(state());
  }

  /** 读封禁名单：引擎的 banlist.json + 本机台账 + 可选的 banlist_reload。 */
  async function loadBanlist(reload = false): Promise<Awaited<ReturnType<typeof api.readBanlist>> | null> {
    const result = await api.readBanlist(state(), { reload });
    if (result === "no-control") {
      notice("warning", "封禁名单", api.NO_CONTROL_MESSAGE);
      return null;
    }
    if (!result.ok) {
      notice("error", "封禁名单", result.error);
      return null;
    }
    return result;
  }

  /**
   * 跑一条 CLI 子命令（`setup` / `upgrade` / `autostart` 这类要提权或要交互的）。
   * 输出原样进动作记录 —— 面板不重写这些命令的实现，避免两套行为。
   */
  async function runCli(args: string[], label: string): Promise<number | undefined> {
    return run(label, async () => {
      const proc = Bun.spawn({
        cmd: selfCommand(args),
        cwd: api.ROOT,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const code = await proc.exited;
      const text = `${out}\n${err}`.trim();
      notice(code === 0 ? "success" : "error", `${label}（退出码 ${code}）`, text.slice(-500) || undefined);
      await refreshState();
      await refreshSlow();
      return code;
    });
  }

  function clearLog(): void {
    setLogLines([]);
  }

  return {
    // 信号
    state,
    versions,
    instance,
    players,
    playersError,
    catalog,
    families,
    health,
    host,
    capabilities,
    shards,
    notices,
    consoleLog,
    busy,
    logLines,
    logPath,
    following,
    setFollowing,
    // 派生
    profiles: (): ProfileRow[] => api.listProfiles(state()),
    settings: (): Settings => state().settings,
    running: (): boolean => instance()?.alive === true,
    // 生命周期
    start,
    dispose,
    // 刷新
    refreshState,
    refreshFast,
    refreshSlow,
    refreshVersions,
    refreshCatalog,
    loadAnnouncements,
    // 动作
    startServer,
    stopServer,
    restartServer,
    useVersion,
    console,
    moderate,
    addBots,
    clearBots,
    switchMode,
    broadcast,
    saveAnnouncements,
    saveSettings,
    resetSetting,
    activateProfile,
    writeProfile,
    openShard,
    clearLog,
    ledger: readLedger,
    loadBanlist,
    runCli,
    pollLog,
    // 通知
    notice,
    dismiss,
    clearNotices,
    run,
  };
}

let singleton: Session | undefined;

/** 单窗口应用：会话是模块级单例。热重载时先把上一个的定时器关掉。 */
export function session(): Session {
  if (!singleton) {
    singleton = createSession();
    singleton.start();
    if (import.meta.hot) {
      import.meta.hot.dispose(() => {
        singleton?.dispose();
        singleton = undefined;
      });
    }
  }
  return singleton;
}
