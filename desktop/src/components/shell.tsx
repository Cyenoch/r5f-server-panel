import { DEV_MODE } from "@server/panel";
/**
 * 应用外壳：标题栏 + 左侧导航 + 右侧内容区 + 状态栏 + 动作记录。
 *
 * 布局契约（GPUI 不是 CSS，抄 CSS 的写法会让滚动区塌成 0）：
 * 从窗口根到滚动容器，每一层都要显式 `flexDirection`、`minWidth: 0`、`minHeight: 0`，
 * 滚动的那一层用 `height: 0 + flexGrow: 1`。
 *
 * 条件与列表用 `? :` 与 `.map()`；按钮用 `Action`（面板自有一套 tone/hover 配色）——
 * 渲染器侧的约束见 `components/ui.tsx` 开头。
 */
import { Icon, Pressable, Text, View, type SolidChild } from "@solid-gpui/core";
import {
  Dialog,
  Separator,
  Sidebar,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  Spinner,
  TitleBar,
  useNative,
} from "@solid-gpui/core/components";
import { createEffect, createMemo, createSignal } from "@solid-gpui/core/runtime";
import { Outlet, useLocation, useNavigate } from "@solid-gpui/router";
import { Action, Chip } from "../components/ui";
import { formatRelative } from "../lib/format";
import { setWindowTitle } from "../lib/host";
import { NAV, navItemFor } from "../lib/nav";
import { session, type Notice, type NoticeKind } from "../lib/session";
import { fontSize, palette, panelTheme, space } from "../lib/theme";

const NOTICE_COLOR: Record<NoticeKind, string> = {
  info: palette.info,
  success: palette.success,
  warning: palette.warning,
  error: palette.danger,
};

const NOTICE_ICON: Record<NoticeKind, "lucide:info" | "lucide:check" | "lucide:triangle-alert" | "lucide:x"> = {
  info: "lucide:info",
  success: "lucide:check",
  warning: "lucide:triangle-alert",
  error: "lucide:x",
};

/** 侧栏徽标：只显示数字，没有值时留空。 */
function badge(value: string): SolidChild {
  if (value.length === 0) return null;
  return (
    <View
      style={{
        paddingLeft: 6,
        paddingRight: 6,
        paddingTop: 1,
        paddingBottom: 1,
        backgroundColor: palette.primary,
        borderRadius: 9,
      }}
    >
      <Text style={{ fontSize: fontSize.xs, color: palette.primaryForeground }}>{value}</Text>
    </View>
  );
}

export function Shell(): SolidChild {
  const store = session();
  const navigate = useNavigate();
  const location = useLocation();
  const native = useNative();
  const [collapsed, setCollapsed] = createSignal(false);
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [confirmStop, setConfirmStop] = createSignal(false);

  const active = createMemo(() => navItemFor(location().pathname));
  const instance = store.instance;
  const running = () => instance()?.alive === true;

  /**
   * 标题栏那个"启动服务器"：没选版本就直接把人带到版本列表 —— 空着一只手按下去只会报错。
   * 起得来就跳实时日志：服主按完启动最想看的就是它在刷日志。
   */
  async function startFromTitleBar(): Promise<void> {
    if (store.state().current === null) {
      await navigate({ to: "/server/list" });
      store.notice("warning", "还没选版本", "在服务器列表里挑一个版本，再点启动。");
      return;
    }
    const result = await store.startServer({});
    if (result?.ok) await navigate({ to: "/server/logs" });
  }
  const players = () => Number.parseInt(instance()?.metrics?.players ?? "", 10) || 0;
  const latest = createMemo(() => {
    const notices = store.notices();
    return notices.length > 0 ? notices[0] : null;
  });

  const badgeFor = (source: "instances" | "players" | undefined): string => {
    if (source === "instances") return running() ? "1" : "";
    if (source === "players") return players() > 0 ? String(players()) : "";
    return "";
  };

  // 主题与窗口标题：只在这里设置一次，页面不动这两样。
  createEffect(() => {
    void native.setTheme("dark").catch(() => {});
    void native.setApplicationTheme(panelTheme).catch(() => {});
  });
  createEffect(() => {
    const metrics = instance();
    const status = metrics?.alive ? `运行中 · UDP ${metrics.port}` : "未运行";
    // 开发模式（R5F_DEV=1）下的数据全是本机假实现，标题必须自己说出来：截图、录屏、
    // 任务栏预览里都能看出这不是一台真服务器。
    setWindowTitle(`${DEV_MODE ? "[模拟] " : ""}R5Flowstate 服务器管理 — ${status}`);
  });

  return (
    <View style={{ flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "column", backgroundColor: palette.bg }}>
      <TitleBar
        style={{
          height: 44,
          padding: 0,
          paddingLeft: space.md,
          paddingRight: space.sm,
          backgroundColor: palette.sidebar,
          borderWidth: 0,
          borderBottomWidth: 1,
          borderColor: palette.borderSoft,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, flexGrow: 1, minWidth: 0 }}>
          <Icon name="lucide:zap" size={16} color={palette.primary} />
          <Text style={{ fontSize: fontSize.md, fontWeight: "semibold", color: palette.text }}>R5Flowstate</Text>
          {/*
            开发模式（R5F_DEV=1）的常驻标记：外壳是所有页面的根布局，所以这一个徽标在
            每一页上都看得见。数据来自 `src/dev-*` 的本机假实现，必须一眼能认出来。
          */}
          {DEV_MODE ? <Chip tone="warning" icon="lucide:triangle-alert" label="模拟数据" /> : null}
          {active() ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
              <Icon name="lucide:chevron-right" size={13} color={palette.textDim} />
              <Text style={{ fontSize: fontSize.md, color: palette.textMuted }}>{active()?.label}</Text>
            </View>
          ) : null}
          <View style={{ flexGrow: 1, minWidth: 0 }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingRight: space.md }}>
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: running() ? palette.success : palette.textDim,
              }}
            />
            <Text style={{ fontSize: fontSize.sm, color: running() ? palette.success : palette.textDim }}>
              {running() ? "运行中" : "未运行"}
            </Text>
          </View>
          {/* 开关服是最常用的动作，放标题栏，任何页面都能直接按。 */}
          {running() ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingRight: space.sm }}>
              <Action
                label="重启"
                icon="lucide:refresh-cw"
                compact
                disabled={store.busy() !== null}
                onPress={() => void store.restartServer()}
              />
              <Action
                label="停止"
                icon="lucide:power"
                compact
                tone="danger"
                disabled={store.busy() !== null}
                onPress={() => setConfirmStop(true)}
              />
            </View>
          ) : (
            <View style={{ paddingRight: space.sm }}>
              <Action
                label="启动服务器"
                icon="lucide:play"
                compact
                tone="info"
                variant="solid"
                disabled={store.busy() !== null}
                onPress={() => void startFromTitleBar()}
              />
            </View>
          )}
        </View>
      </TitleBar>

      <View style={{ height: 0, flexDirection: "row", flexGrow: 1, minHeight: 0, minWidth: 0 }}>
        <Sidebar
          side="left"
          collapsed={collapsed()}
          collapsible="icon"
          slots={{
            header: (
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm }}>
                <Icon name="lucide:monitor" size={18} color={palette.primary} />
                {collapsed() ? null : (
                  <Text style={{ fontSize: fontSize.md, fontWeight: "semibold", color: palette.text }}>服务器管理</Text>
                )}
              </View>
            ),
            footer: (
              <View style={{ padding: space.sm }}>
                <Action
                  icon={collapsed() ? "lucide:chevron-right" : "lucide:arrow-left"}
                  label={collapsed() ? undefined : "收起导航"}
                  variant="ghost"
                  compact
                  tooltip={collapsed() ? "展开导航" : "收起导航"}
                  onPress={() => setCollapsed((value) => !value)}
                />
              </View>
            ),
          }}
        >
          {NAV.map((navGroup) => (
            <SidebarGroup label={navGroup.label}>
              {/* SidebarGroup 的子节点必须是 SidebarPart：菜单项要先包一层 SidebarMenu。 */}
              <SidebarMenu>
                {navGroup.items.map((item) => (
                  <SidebarMenuItem
                    label={item.label}
                    icon={item.icon}
                    active={active()?.to === item.to}
                    slots={{ suffix: badge(badgeFor(item.badge)) }}
                    onPress={() => void navigate({ to: item.to })}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </Sidebar>

        <View style={{ width: 0, flexGrow: 1, minWidth: 0, minHeight: 0, flexDirection: "column" }}>
          {/*
            页面槽位：`flexDirection: "column"` 不能省 —— 默认是 row，子节点的 `flexGrow`
            会去撑宽而不是撑高，页面里的 `height: 0 + flexGrow: 1` 滚动容器会塌成 0 高度。
          */}
          <View style={{ height: 0, flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "column" }}>
            <Outlet />
          </View>
        </View>
      </View>

      <View
        style={{
          height: 30,
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          paddingLeft: space.md,
          paddingRight: space.sm,
          backgroundColor: palette.sidebar,
          borderWidth: 0,
          borderTopWidth: 1,
          borderColor: palette.borderSoft,
        }}
      >
        <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>
          {store.state().current ? `版本 ${store.state().current}` : "未选择版本"}
        </Text>
        <Separator orientation="vertical" />
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
          <Icon name="lucide:users" size={13} color={players() > 0 ? palette.success : palette.textDim} />
          <Text style={{ fontSize: fontSize.sm, color: players() > 0 ? palette.success : palette.textDim }}>
            {players()} 人
          </Text>
        </View>
        <Separator orientation="vertical" />
        <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>UDP {store.settings().port}</Text>
        <View style={{ flexGrow: 1, minWidth: 0 }} />
        {/* 正在跑的动作优先显示：按下去要有反应，不能等结果出来才动。 */}
        {store.busy() !== null ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
            <Spinner size="small" color={palette.info} />
            <Text style={{ fontSize: fontSize.sm, color: palette.info }}>{`${store.busy()}…`}</Text>
          </View>
        ) : latest() ? (
          <Pressable
            onPress={() => setHistoryOpen(true)}
            style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}
          >
            <Icon name={NOTICE_ICON[latest()!.kind]} size={13} color={NOTICE_COLOR[latest()!.kind]} />
            <Text style={{ fontSize: fontSize.sm, color: NOTICE_COLOR[latest()!.kind] }}>{latest()!.title}</Text>
            <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>· 查看</Text>
          </Pressable>
        ) : null}
        <Action
          icon="lucide:clipboard-list"
          label={`动作记录 (${store.notices().length})`}
          variant="ghost"
          compact
          onPress={() => setHistoryOpen(true)}
        />
      </View>

      {/* 停止是不可逆地打断正在玩的玩家，标题栏这个入口也必须确认。 */}
      <Dialog
        open={confirmStop()}
        title="停止服务器？"
        width={420}
        buttons={{ okText: "停止", cancelText: "继续运行", okVariant: "danger", showCancel: true }}
        onAction={(action) => {
          setConfirmStop(false);
          if (action.kind === "ok") void store.stopServer();
        }}
      >
        <Text style={{ color: palette.textMuted, fontSize: fontSize.md }}>
          正在游戏里的玩家会被断开，未保存的比分不计。确认要停就点"停止"。
        </Text>
      </Dialog>

      <Dialog
        open={historyOpen()}
        title="动作记录"
        width={560}
        buttons={{ okText: "清空", cancelText: "关闭", okVariant: "secondary", showCancel: true, closeOnOk: false }}
        onAction={(action) => {
          if (action.kind === "ok") store.clearNotices();
          else setHistoryOpen(false);
        }}
      >
        <View style={{ gap: space.sm, maxHeight: 420 }}>
          {store.notices().length === 0 ? (
            <Text style={{ color: palette.textDim, fontSize: fontSize.md }}>还没有动作记录。</Text>
          ) : (
            store.notices().map((entry: Notice) => (
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
                <Icon name={NOTICE_ICON[entry.kind]} size={14} color={NOTICE_COLOR[entry.kind]} />
                <View style={{ flexGrow: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: fontSize.md, color: palette.text }}>{entry.title}</Text>
                  {entry.detail ? (
                    <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>{entry.detail}</Text>
                  ) : null}
                </View>
                <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>{formatRelative(entry.at)}</Text>
              </View>
            ))
          )}
        </View>
      </Dialog>
    </View>
  );
}
