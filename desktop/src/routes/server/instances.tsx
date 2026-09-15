/**
 * `/server/instances` —— 实例：当前实例的进程信息与资源占用。
 *
 * 三种状态必须分开说，不能混成一种：
 *  - `instance()` 为 null：面板还没有记录；首次读取完成前只能说"正在读取"；
 *  - `alive === false`：记录里还剩上一次运行的痕迹，进程已经不在，那些数字是旧的；
 *  - 真在跑：统计才有意义，且人数/地图/CPU 来自引擎窗口标题，读不到就如实写"—"。
 *
 * 页面不直接依赖 `@server/panel` 的类型：所有取值都从 `store.instance()` 的访问器上现读，
 * 这样每个 `<Text>`/`Stat` 各自跟着信号更新，也不会把页面焊在引擎那份结构上。
 */
import { Text, View, type SolidChild } from "@solid-gpui/core";
import { createEffect, createSignal, untrack } from "@solid-gpui/core/runtime";
import { createFileRoute, useNavigate } from "@solid-gpui/router";
import {
  Action,
  Card,
  Confirm,
  EmptyHint,
  KeyValueList,
  Note,
  PageHeader,
  SectionTitle,
  Stat,
  Toolbar,
  PageScroll,
} from "../../components/ui";
import { formatClock, formatCpu, formatDuration, formatRelative } from "../../lib/format";
import { session } from "../../lib/session";
import { fontSize, palette, space } from "../../lib/theme";

export const Route = createFileRoute("/server/instances")({ component: Page });

function Page(): SolidChild {
  const store = session();
  const navigate = useNavigate();
  const instance = store.instance;
  const [probed, setProbed] = createSignal(instance() !== null);
  const [confirmStop, setConfirmStop] = createSignal(false);
  const [confirmRestart, setConfirmRestart] = createSignal(false);
  const [confirmStopAll, setConfirmStopAll] = createSignal(false);

  // 首次进来先自己读一次：上一次的进程记录还没读完之前，不要假装"没有实例"。
  createEffect(() => {
    untrack(() => {
      void store.refreshFast().then(() => setProbed(true));
    });
  });

  return (
    <PageScroll
      style={{
        flexGrow: 1,
        minHeight: 0,
        minWidth: 0,
        flexDirection: "column",
        gap: space.lg,
        padding: space.xl,
        overflow: "scroll",
      }}
    >
      <PageHeader
        title="运行中的服务器"
        icon="lucide:cpu"
        description="这台电脑上正在跑的服务器"
        actions={
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Action
              label="刷新"
              icon="lucide:refresh-cw"
              disabled={store.busy() !== null}
              onPress={() => void store.refreshFast()}
            />
            <Action
              label="停止全部"
              icon="lucide:square"
              tone="danger"
              disabled={store.busy() !== null}
              tooltip="停掉这台电脑上所有正在跑的服务器"
              onPress={() => setConfirmStopAll(true)}
            />
          </View>
        }
      />

      {instance() === null && !probed() ? (
        <View style={{ flexGrow: 1, minHeight: 0, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: fontSize.md, color: palette.textDim }}>正在读取服务器状态…</Text>
        </View>
      ) : instance() === null ? (
        <EmptyHint
          icon="lucide:cpu"
          title="没有正在运行的服务器"
          description="面板的记录里还没有正在跑的服务器。"
          action={
            <Action
              label="去列表启动"
              icon="lucide:play"
              tone="info"
              variant="solid"
              onPress={() => void navigate({ to: "/server/list" })}
            />
          }
        />
      ) : instance()!.alive ? (
        <Card
          title="正在运行的服务器"
          icon="lucide:cpu"
          tone={instance()!.hosted ? "success" : "warning"}
          subtitle={`版本 ${instance()!.version}`}
          actions={
            <Toolbar>
              <Action
                label="查看日志"
                icon="lucide:list"
                compact
                onPress={() => void navigate({ to: "/server/logs" })}
              />
              <Action
                label="玩家"
                icon="lucide:users"
                compact
                onPress={() => void navigate({ to: "/server/players" })}
              />
              <Action label="重启" icon="lucide:refresh-cw" compact onPress={() => setConfirmRestart(true)} />
              <Action label="停止" icon="lucide:square" tone="danger" compact onPress={() => setConfirmStop(true)} />
            </Toolbar>
          }
        >
          <View style={{ gap: space.md }}>
            {instance()!.hosted ? null : (
              <Note tone="warning" text="面板没接上这台服务器：重启可以补上，不然读不到玩家，也没法从面板发指令。" />
            )}
            <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
              <Stat
                label="运行时长"
                value={formatDuration(instance()!.startedAt)}
                icon="lucide:clock"
                tone="info"
                hint={`启动于 ${formatRelative(instance()!.startedAt)}`}
              />
              <Stat
                label="在线玩家"
                value={instance()!.metrics?.players ?? "—"}
                unit={instance()!.metrics?.players ? "人" : undefined}
                icon="lucide:users"
                tone={Number.parseInt(instance()!.metrics?.players ?? "", 10) > 0 ? "success" : "neutral"}
                hint={instance()!.metrics ? undefined : "服务器没有回话，这一条读不到"}
              />
              <Stat
                label="内存"
                value={String(instance()!.workingSetMB)}
                unit="MB"
                icon="lucide:hard-drive"
                hint={`其中 ${instance()!.privateMB} MB 是它独占的`}
              />
              <Stat
                label="CPU"
                value={instance()!.cpuSeconds > 0 ? formatCpu(instance()!.cpuSeconds, instance()!.startedAt) : "—"}
                icon="lucide:cpu"
                hint={instance()!.metrics?.cpuPercent ? `服务器自报 ${instance()!.metrics?.cpuPercent}%` : undefined}
              />
              <Stat
                label="地图"
                value={instance()!.live?.map ?? store.settings().map}
                icon="lucide:layers"
                hint={
                  instance()!.live
                    ? `服务器 ${formatClock(instance()!.live?.at ?? "")} 回过话`
                    : "来自启动设置，服务器没有回话"
                }
              />
            </View>
            <View style={{ gap: space.xs }}>
              <SectionTitle text="给排障看的信息" icon="lucide:clipboard-list" />
              <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>这些是出问题时给帮忙的人看的</Text>
            </View>
            <KeyValueList
              rows={[
                { label: "进程号", value: String(instance()!.pid), mono: true },
                { label: "版本", value: instance()!.version },
                { label: "端口", value: `UDP ${instance()!.port}`, mono: true },
                {
                  label: "控制通道",
                  value: instance()!.hosted ? `127.0.0.1:${instance()!.ctlPort ?? "—"}` : "面板没接上",
                  tone: instance()!.hosted ? "success" : "warning",
                  mono: instance()!.hosted,
                },
                {
                  label: "监听地址",
                  value:
                    instance()!.endpoints.length > 0
                      ? instance()!.endpoints.join(" ")
                      : "还没读出来（服务器可能还没准备好）",
                  mono: instance()!.endpoints.length > 0,
                },
                {
                  label: "日志",
                  value: instance()!.logFile ? "面板已接上，在实时日志页能看" : "面板没接上，这次运行不写日志",
                },
              ]}
            />
          </View>
        </Card>
      ) : (
        <Note
          tone="warning"
          text={`服务器已经停止：面板里还留着上一次运行的记录（${instance()!.version}，启动于 ${formatRelative(instance()!.startedAt)}），那些数字都是旧的。清掉记录再重新启动，才是干净的状态。`}
          action={
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <Action label="清除记录" icon="lucide:trash-2" compact onPress={() => void store.refreshState()} />
              <Action
                label="重新启动"
                icon="lucide:play"
                tone="info"
                variant="solid"
                compact
                onPress={() => void store.restartServer()}
              />
            </View>
          }
        />
      )}

      <Confirm
        open={confirmStop()}
        title="停止服务器"
        message="会把服务器和它的日志一起停掉，正在玩的玩家会立刻掉线。"
        confirmLabel="停止"
        danger
        onConfirm={() => {
          setConfirmStop(false);
          void store.stopServer();
        }}
        onCancel={() => setConfirmStop(false)}
      />
      <Confirm
        open={confirmRestart()}
        title="重启服务器"
        message="先停掉现在这台服务器，再按当前设置重新启动；这段时间玩家会掉线。"
        confirmLabel="重启"
        onConfirm={() => {
          setConfirmRestart(false);
          void store.restartServer();
        }}
        onCancel={() => setConfirmRestart(false)}
      />
      <Confirm
        open={confirmStopAll()}
        title="停止全部服务器"
        message="停掉面板记录的这台服务器，以及这里所有其它正在跑的服务器（包括面板没记录到的）。"
        confirmLabel="停止全部"
        danger
        onConfirm={() => {
          setConfirmStopAll(false);
          void store.stopServer(true);
        }}
        onCancel={() => setConfirmStopAll(false)}
      />
    </PageScroll>
  );
}
