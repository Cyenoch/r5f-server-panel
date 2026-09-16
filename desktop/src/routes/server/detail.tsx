import { type SolidChild } from "@solid-gpui/core";
import { createFileRoute } from "@solid-gpui/router";
import { Statistics } from "../../components/statistics";
import { Card, EmptyHint, KeyValueList, PageScroll } from "../../components/ui";
import { formatDuration } from "../../lib/format";
import { session } from "../../lib/session";
import { space } from "../../lib/theme";
export const Route = createFileRoute("/server/detail")({ component: Detail });
function Detail(): SolidChild {
  const store = session();
  return (
    <PageScroll style={{ gap: space.lg, padding: space.xl }}>
      {store.selected() ? (
        <>
          <Statistics instanceId={store.selected()!.id} />
          <Card title="运行信息" icon="lucide:cpu">
            <KeyValueList
              rows={[
                { label: "实例名称", value: store.selected()!.name },
                { label: "运行时长", value: store.running() ? formatDuration(store.instance()!.startedAt) : "未运行" },
                { label: "启动配置版本", value: store.selected()!.version ?? "未选择" },
                { label: "当前运行版本", value: store.running() ? store.instance()!.version : "—" },
                {
                  label: "当前地图",
                  value: store.instance()?.live?.map ?? store.instance()?.metrics?.map ?? "尚未读取",
                },
                {
                  label: "当前模式",
                  value: store.instance()?.live?.playlist ?? store.instance()?.metrics?.playlist ?? "尚未读取",
                },
                { label: "进程号", value: store.running() ? String(store.instance()!.pid) : "—", mono: true },
                {
                  label: "控制通道",
                  value: store.running() ? (store.instance()?.hosted ? "已连接 · 仅本机回环" : "未连接") : "未运行",
                },
                { label: "运行端口", value: store.running() ? `UDP ${store.instance()!.port}` : "—" },
              ]}
            />
          </Card>
        </>
      ) : (
        <EmptyHint title="尚未选择实例" description="从服务器实例列表打开一个实例。" />
      )}
    </PageScroll>
  );
}
