import { Text, View, type SolidChild } from "@solid-gpui/core";
import { Select } from "@solid-gpui/core/components";
import { createSignal } from "@solid-gpui/core/runtime";
import { useLocation, useNavigate } from "@solid-gpui/router";
import * as api from "#server/panel";
import { session } from "../lib/session";
import { fontSize, palette, space } from "../lib/theme";
import { Action, Chip, Confirm, Note, Toolbar } from "./ui";

export const INSTANCE_TABS = [
  { path: "/server/detail", label: "概览" },
  { path: "/server/logs", label: "控制台" },
  { path: "/server/players", label: "玩家" },
  { path: "/config/server", label: "设置" },
  { path: "/config/announcements", label: "公告" },
  { path: "/ops/health", label: "健康" },
  { path: "/ops/banlist", label: "封禁" },
] as const;

export function InstanceContext(): SolidChild {
  const store = session();
  const navigate = useNavigate();
  const location = useLocation();
  const [confirmation, setConfirmation] = createSignal<{
    id: string;
    name: string;
    action: "stop" | "restart" | "template" | "parameters";
  } | null>(null);
  const pending = () =>
    store.running() && store.selected() ? api.instancePendingChanges(store.state(), store.selected()!) : [];
  const request = (action: "stop" | "restart" | "template" | "parameters") => {
    const target = store.selected();
    if (target) setConfirmation({ id: target.id, name: target.name, action });
  };
  async function confirmed(): Promise<void> {
    const target = confirmation();
    setConfirmation(null);
    if (!target || target.id !== store.selected()?.id) {
      store.notice("warning", "实例已切换，请重新确认操作");
      return;
    }
    if (target.action === "stop") await store.stopServer();
    else if (target.action === "restart") await store.restartServer();
    else {
      const result = await store.run("应用玩法模板", () =>
        api.applyInstanceTemplate(store.state(), { reload: target.action === "template" }),
      );
      if (result)
        store.notice(
          result.kind === "error" ? "error" : result.kind === "success" ? "success" : "warning",
          "应用玩法",
          result.message,
        );
      await store.refreshState();
      await store.refreshFast();
    }
  }
  return (
    <View
      style={{
        flexDirection: "column",
        gap: space.md,
        padding: space.lg,
        paddingBottom: space.sm,
        borderBottomWidth: 1,
        borderColor: palette.borderSoft,
        backgroundColor: palette.panel,
      }}
    >
      <Toolbar>
        <Action
          label="实例"
          icon="lucide:arrow-left"
          compact
          variant="ghost"
          onPress={() => void navigate({ to: "/server/instances" })}
        />
        <View style={{ width: 250 }}>
          <Select
            accessibilityLabel="当前实例"
            value={store.selected()?.id}
            placeholder="选择实例"
            disabled={store.busy() !== null}
            items={[
              { key: "instances", items: store.state().instances.map((item) => ({ key: item.id, label: item.name })) },
            ]}
            onChange={(change) => {
              if (change.value) void store.selectInstance(change.value);
            }}
          />
        </View>
        <Chip label={store.running() ? "运行中" : "已停止"} tone={store.running() ? "success" : "neutral"} />
        <View style={{ flexGrow: 1, width: 0 }} />
        {store.running() ? (
          <>
            {store.selected()?.templateId ? (
              <>
                <Action
                  label="应用运行参数"
                  icon="lucide:sliders-horizontal"
                  compact
                  disabled={store.busy() !== null}
                  onPress={() => request("parameters")}
                />
                <Action
                  label="重新加载玩法"
                  icon="lucide:puzzle"
                  compact
                  disabled={store.busy() !== null}
                  onPress={() => request("template")}
                />
              </>
            ) : null}
            <Action
              label="重启实例"
              icon="lucide:refresh-cw"
              compact
              disabled={store.busy() !== null}
              onPress={() => request("restart")}
            />
            <Action
              label="停止实例"
              icon="lucide:square"
              tone="danger"
              compact
              disabled={store.busy() !== null}
              onPress={() => request("stop")}
            />
          </>
        ) : (
          <Action
            label="启动实例"
            icon="lucide:play"
            tone="info"
            variant="solid"
            compact
            disabled={!store.selected()?.version || store.busy() !== null}
            onPress={() =>
              void store.startServer().then((result) => {
                if (result?.ok) void navigate({ to: "/server/logs" });
              })
            }
          />
        )}
      </Toolbar>
      <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
        {store.selected()
          ? `${store.selected()!.name} · ${store.selected()!.version ?? "未选版本"} · 配置端口 ${store.settings().port}`
          : "选择实例后查看详情；所有操作只作用于此实例。"}
      </Text>
      {pending().length ? <Note tone="warning" text={`有配置尚未应用：${pending().join("；")}`} /> : null}
      <Toolbar gap={space.xs}>
        {INSTANCE_TABS.map((tab) => (
          <Action
            label={tab.label}
            compact
            variant={location().pathname === tab.path ? "solid" : "ghost"}
            tone={location().pathname === tab.path ? "info" : "neutral"}
            onPress={() => void navigate({ to: tab.path })}
          />
        ))}
      </Toolbar>
      <Confirm
        open={confirmation() !== null}
        title={
          confirmation()?.action === "parameters"
            ? "应用运行参数？"
            : confirmation()?.action === "template"
              ? "应用玩法并重新加载地图？"
              : confirmation()?.action === "restart"
                ? "重启实例？"
                : "停止实例？"
        }
        message={
          confirmation()?.action === "parameters"
            ? `将模板参数应用到「${confirmation()?.name}」，不主动换图。每轮读取的参数在后续轮次生效；1v1 单局时长等缓存参数仍需换图，不能保证当前对局立即采用。`
            : confirmation()?.action === "template"
              ? `将「${confirmation()?.name}」绑定模板的参数发往服务器并换图。进程不重启，但当前对局会中断；无回执的命令不会标成已生效。`
              : `仅操作「${confirmation()?.name ?? ""}」。当前玩家会断开，其他实例不受影响。`
        }
        danger={confirmation()?.action === "stop"}
        confirmLabel="确认执行"
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void confirmed()}
      />
    </View>
  );
}
