import { View, Text, type SolidChild } from "@solid-gpui/core";
import { createFileRoute, useNavigate } from "@solid-gpui/router";
import { Action, Card, Chip, Note, PageHeader, PageScroll, Toolbar } from "../components/ui";
import { session } from "../lib/session";
import { fontSize, palette, space } from "../lib/theme";
export const Route = createFileRoute("/setup")({ component: Checklist });
function Checklist(): SolidChild {
  const store = session();
  const navigate = useNavigate();
  return (
    <PageScroll style={{ gap: space.lg, padding: space.xl }}>
      <PageHeader
        title="开服检查清单"
        icon="lucide:check-square"
        description="安装 → 定义玩法 → 创建实例 → 确认网络。面板不会把本机端口放行误报为公网可达。"
      />
      <Card title="1 · 安装服务端" icon="lucide:download">
        <Toolbar>
          <Chip
            label={store.versions().length ? `已安装 ${store.versions().length} 个版本` : "尚未安装"}
            tone={store.versions().length ? "success" : "warning"}
          />
          <View style={{ flexGrow: 1 }} />
          <Action label="打开版本库" onPress={() => void navigate({ to: "/server/list" })} />
        </Toolbar>
      </Card>
      <Card title="2 · 定义游戏模式模板" icon="lucide:puzzle">
        <Toolbar>
          <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>
            选择玩法、地图和真实游戏参数；可被多个实例使用。
          </Text>
          <View style={{ flexGrow: 1 }} />
          <Action label="管理模板" onPress={() => void navigate({ to: "/config/modes" })} />
        </Toolbar>
      </Card>
      <Card title="3 · 创建实例" icon="lucide:layers">
        <Toolbar>
          <Chip label={`${store.state().instances.length} 个实例`} />
          <View style={{ flexGrow: 1 }} />
          <Action label="管理实例" onPress={() => void navigate({ to: "/server/instances" })} />
        </Toolbar>
      </Card>
      <Card title="4 · 联网与运行检查" icon="lucide:globe">
        {store.selected() ? (
          <>
            <Text
              style={{ fontSize: fontSize.md, color: palette.text }}
            >{`当前检查：${store.selected()!.name} · UDP ${store.settings().port}`}</Text>
            <Note
              text={
                store.settings().visibility === 0
                  ? "该实例选择离线，不发布到公开列表。若需联网，在实例设置中更改可见性。"
                  : store.settings().hostip
                    ? `已填写公网地址 ${store.settings().hostip}，仍需确认出口 IP、Windows 防火墙与云安全组。`
                    : "该实例选择联网，但尚未填写公网地址。NAT 主机通常必须手动配置。"
              }
            />
            <Toolbar>
              {store.settings().visibility === 0 ? null : (
                <Action
                  label={store.settings().hostip.length > 0 ? "重新获取公网 IP" : "获取公网 IP"}
                  icon="lucide:globe"
                  variant="solid"
                  disabled={store.busy() !== null}
                  tooltip={`问回显服务要本机公网 IPv4，写成 IP:${store.settings().port} 存进「公网地址」`}
                  onPress={() => void store.detectHostip()}
                />
              )}
              <Action label="实例设置" onPress={() => void navigate({ to: "/config/server" })} />
              <Action label="主机环境" onPress={() => void navigate({ to: "/config/host" })} />
              <Action label="运行与健康" onPress={() => void navigate({ to: "/ops/health" })} />
            </Toolbar>
          </>
        ) : (
          <Note text="先打开一个实例，再检查它的网络设置。" />
        )}
      </Card>
    </PageScroll>
  );
}
