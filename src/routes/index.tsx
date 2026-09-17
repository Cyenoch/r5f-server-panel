import { Text, View, type SolidChild } from "@solid-gpui/core";
import { createFileRoute, useNavigate } from "@solid-gpui/router";
import { Statistics } from "../components/statistics";
import { Action, Card, Chip, PageHeader, PageScroll, Toolbar } from "../components/ui";
import { session } from "../lib/session";
import { fontSize, palette, space } from "../lib/theme";

export const Route = createFileRoute("/")({ component: Dashboard });
function Dashboard(): SolidChild {
  const store = session();
  const navigate = useNavigate();
  return (
    <PageScroll style={{ gap: space.lg, padding: space.xl }}>
      <PageHeader
        title="总览"
        icon="lucide:gauge"
        description="先看玩家是否在线，再看实例是否稳定。所有数字来自当前主机的实际观测。"
        actions={
          <Action
            label="管理实例"
            icon="lucide:layers"
            tone="info"
            variant="solid"
            onPress={() => void navigate({ to: "/server/instances" })}
          />
        }
      />
      <Statistics />
      <Card
        title="运行中的实例"
        icon="lucide:cpu"
        actions={
          <Action label="查看全部" compact variant="ghost" onPress={() => void navigate({ to: "/server/running" })} />
        }
      >
        {store.fleet().filter((row) => row.metrics?.alive).length === 0 ? (
          <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>
            当前没有运行实例。停止的实例和历史观测仍然保留。
          </Text>
        ) : (
          store
            .fleet()
            .filter((row) => row.metrics?.alive)
            .map((row) => (
              <Toolbar>
                <Chip tone="success" label="运行中" />
                <View style={{ flexGrow: 1, width: 0 }}>
                  <Text style={{ fontSize: fontSize.md, color: palette.text }}>{row.instance.name}</Text>
                  <Text
                    style={{ fontSize: fontSize.xs, color: palette.textDim }}
                  >{`${row.metrics!.version} · UDP ${row.metrics!.port}`}</Text>
                </View>
                <Text style={{ fontSize: fontSize.md, color: palette.textMuted }}>
                  {row.metrics!.metrics?.players ?? "人数未知"}
                </Text>
                <Action
                  label="查看详情"
                  compact
                  onPress={() =>
                    void store.selectInstance(row.instance.id).then(() => navigate({ to: "/server/detail" }))
                  }
                />
              </Toolbar>
            ))
        )}
      </Card>
      <Card title="工作流" icon="lucide:layers">
        <Toolbar>
          <Action label="1 · 安装服务端" icon="lucide:download" onPress={() => void navigate({ to: "/server/list" })} />
          <Action
            label="2 · 定义玩法模板"
            icon="lucide:puzzle"
            onPress={() => void navigate({ to: "/config/modes" })}
          />
          <Action
            label="3 · 创建并启动实例"
            icon="lucide:play"
            onPress={() => void navigate({ to: "/server/instances" })}
          />
        </Toolbar>
      </Card>
    </PageScroll>
  );
}
