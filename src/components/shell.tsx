import { DEV_MODE } from "@server/panel";
import { Icon, Text, View, type SolidChild } from "@solid-gpui/core";
import {
  Dialog,
  Sidebar,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  Spinner,
  TitleBar,
  useNative,
} from "@solid-gpui/core/components";
import { createEffect, createMemo, createSignal, Show } from "@solid-gpui/core/runtime";
import { Outlet, useLocation, useNavigate } from "@solid-gpui/router";
import { formatRelative } from "../lib/format";
import { setWindowTitle } from "../lib/host";
import { NAV, navItemFor } from "../lib/nav";
import { session, type NoticeKind } from "../lib/session";
import { fontSize, palette, panelTheme, space } from "../lib/theme";
import { InstanceContext, INSTANCE_TABS } from "./instance-context";
import { Action, Chip, EmptyHint } from "./ui";
const NOTICE_COLOR: Record<NoticeKind, string> = {
  info: palette.info,
  success: palette.success,
  warning: palette.warning,
  error: palette.danger,
};

export function Shell(): SolidChild {
  const store = session();
  const navigate = useNavigate();
  const location = useLocation();
  const native = useNative();
  const [collapsed, setCollapsed] = createSignal(false);
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const active = createMemo(() => navItemFor(location().pathname));
  const detail = () => INSTANCE_TABS.some((tab) => tab.path === location().pathname);
  const runningCount = createMemo(() => store.fleet().filter((row) => row.metrics?.alive).length);
  const title = createMemo(() => `${DEV_MODE ? "[模拟] " : ""}R5Flowstate · ${runningCount()} 个实例运行中`);
  const latest = () => store.notices()[0];
  createEffect(() => {
    void native.setTheme("dark").catch(() => {});
    void native.setApplicationTheme(panelTheme).catch(() => {});
  });
  createEffect(() => setWindowTitle(title()));
  return (
    <View style={{ flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "column", backgroundColor: palette.bg }}>
      <TitleBar
        style={{
          height: 44,
          paddingLeft: space.md,
          paddingRight: space.md,
          backgroundColor: palette.sidebar,
          borderBottomWidth: 1,
          borderColor: palette.borderSoft,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, minWidth: 0, flexGrow: 1 }}>
          <Icon name="lucide:zap" size={17} color={palette.primary} />
          <Text style={{ fontSize: fontSize.md, fontWeight: "semibold", color: palette.text }}>R5Flowstate</Text>
          <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>服务器工作台</Text>
          {DEV_MODE ? <Chip tone="warning" label="模拟环境" /> : null}
          <View style={{ width: 0, flexGrow: 1 }} />
          <Chip tone={runningCount() ? "success" : "neutral"} label={`${runningCount()} 个运行中`} />
        </View>
      </TitleBar>
      <View style={{ height: 0, flexDirection: "row", flexGrow: 1, minHeight: 0, minWidth: 0 }}>
        <Sidebar
          side="left"
          collapsed={collapsed()}
          collapsible="icon"
          slots={{
            header: (
              <View style={{ padding: space.sm, gap: space.xs }}>
                <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>
                  {collapsed() ? "R5F" : "本机工作区"}
                </Text>
              </View>
            ),
            footer: (
              <View style={{ padding: space.sm }}>
                <Action
                  label={collapsed() ? undefined : "收起导航"}
                  icon={collapsed() ? "lucide:chevron-right" : "lucide:arrow-left"}
                  tooltip={collapsed() ? "展开导航" : "收起导航"}
                  compact
                  variant="ghost"
                  onPress={() => setCollapsed(!collapsed())}
                />
              </View>
            ),
          }}
        >
          {NAV.map((group) => (
            <SidebarGroup label={group.label}>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem
                    label={item.label}
                    icon={item.icon}
                    active={active()?.to === item.to || (detail() && item.to === "/server/instances")}
                    onPress={() => void navigate({ to: item.to })}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </Sidebar>
        <View style={{ width: 0, flexGrow: 1, minWidth: 0, minHeight: 0, flexDirection: "column" }}>
          {detail() ? <InstanceContext /> : null}
          <View style={{ height: 0, flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "column" }}>
            {detail() ? (
              <Show
                when={store.selected()?.id}
                keyed
                fallback={
                  <EmptyHint
                    title="先选择一个实例"
                    description="实例有自己的控制台、玩家、配置和观测数据。"
                    action={<Action label="前往实例列表" onPress={() => void navigate({ to: "/server/instances" })} />}
                  />
                }
              >
                {() => <Outlet />}
              </Show>
            ) : (
              <Outlet />
            )}
          </View>
        </View>
      </View>
      <View
        style={{
          height: 34,
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          paddingLeft: space.md,
          paddingRight: space.sm,
          backgroundColor: palette.sidebar,
          borderTopWidth: 1,
          borderColor: palette.borderSoft,
        }}
      >
        <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
          {DEV_MODE ? "本机模拟 · 不连接真实玩家" : "本机管理 · 无公网控制端口"}
        </Text>
        <View style={{ width: 0, flexGrow: 1 }} />
        {store.busy() ? (
          <>
            <Spinner size="small" color={palette.info} />
            <Text style={{ fontSize: fontSize.sm, color: palette.info }}>{store.busy()}…</Text>
          </>
        ) : latest() ? (
          <Text style={{ fontSize: fontSize.sm, color: NOTICE_COLOR[latest().kind] }}>{latest().title}</Text>
        ) : null}
        <Action
          icon="lucide:clipboard-list"
          label={`操作记录 (${store.notices().length})`}
          variant="ghost"
          compact
          onPress={() => setHistoryOpen(true)}
        />
      </View>
      <Dialog
        open={historyOpen()}
        title="操作记录"
        width={660}
        buttons={{ okText: "关闭", showCancel: false }}
        onAction={() => setHistoryOpen(false)}
        onOpenChange={(event) => {
          if (!event.open) setHistoryOpen(false);
        }}
      >
        <View style={{ gap: space.md, maxHeight: 460, overflow: "scroll" }}>
          {store.notices().length ? (
            store.notices().map((entry) => (
              <View style={{ gap: space.xs }}>
                <View style={{ flexDirection: "row", gap: space.sm }}>
                  <Text style={{ fontSize: fontSize.md, color: NOTICE_COLOR[entry.kind], flexGrow: 1 }}>
                    {entry.title}
                  </Text>
                  <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>{formatRelative(entry.at)}</Text>
                </View>
                {entry.detail ? (
                  <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>{entry.detail}</Text>
                ) : null}
              </View>
            ))
          ) : (
            <Text style={{ color: palette.textDim }}>还没有操作记录。</Text>
          )}
        </View>
      </Dialog>
    </View>
  );
}
