import { Icon, Text, View, type SolidChild } from "@solid-gpui/core";
import { Separator } from "@solid-gpui/core/components";
import { createMemo } from "@solid-gpui/core/runtime";
import { createFileRoute, useNavigate } from "@solid-gpui/router";
import { Action, Card, EmptyHint, Note, PageHeader, Stat, PageScroll } from "../components/ui";
import { formatCpu, formatDuration, formatRelative, shortId } from "../lib/format";
import { onboardingSteps } from "../lib/nav";
import { session } from "../lib/session";
import { font, fontSize, palette, radius, space } from "../lib/theme";

export const Route = createFileRoute("/")({ component: Dashboard });

/** 面板里到处要的「标签 + 值」一行。 */
function InfoRow(props: {
  label: string;
  value: string;
  tone?: "success" | "warning" | "danger";
  mono?: boolean;
}): SolidChild {
  const color =
    props.tone === "success"
      ? palette.success
      : props.tone === "warning"
        ? palette.warning
        : props.tone === "danger"
          ? palette.danger
          : palette.text;
  return (
    <View style={{ flexDirection: "row", gap: space.sm, minWidth: 0 }}>
      <Text style={{ width: 76, flexShrink: 0, fontSize: fontSize.sm, color: palette.textDim }}>{props.label}</Text>
      <Text
        style={{
          flexGrow: 1,
          minWidth: 0,
          fontSize: fontSize.md,
          color,
          fontFamily: props.mono ? font.mono : undefined,
        }}
      >
        {props.value}
      </Text>
    </View>
  );
}

function Dashboard(): SolidChild {
  const store = session();
  const navigate = useNavigate();
  const instance = store.instance;
  const running = () => instance()?.alive === true;

  const steps = createMemo(() =>
    onboardingSteps({
      hasVersion: store.versions().length > 0,
      hostnameSet: store.settings().hostname.trim().length > 0,
      hostipSet: store.settings().hostip.trim().length > 0,
      firewallConfigured: store.capabilities().some((item) => item.id === "firewall" && item.enabled),
    }),
  );
  const pending = createMemo(() => steps().filter((step) => !step.done));
  const logTail = createMemo(() => store.logLines().slice(-14));
  const health = store.health;
  const errorBytes = () => health()?.error.bytes ?? 0;

  if (!running()) {
    return (
      <PageScroll style={{ gap: space.lg, padding: space.xl }}>
        <EmptyHint
          icon="lucide:power"
          title="服务器已停止"
          description="还没选好要开哪个版本：去服务器列表挑一个，就能启动。"
          action={
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <Action
                label="启动服务器"
                icon="lucide:play"
                tone="info"
                variant="solid"
                onPress={() => void navigate({ to: "/server/list" })}
              />
              <Action label="启动引导" icon="lucide:rocket" onPress={() => void navigate({ to: "/setup" })} />
            </View>
          }
        />
        {pending().length > 0 ? (
          <View style={{ padding: space.xl, paddingTop: 0, gap: space.lg }}>
            <Card title="首次使用还差几步" icon="lucide:rocket" tone="warning" subtitle="按顺序做完就能对外开服">
              <View style={{ gap: space.sm }}>
                {steps().map((step) => (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                    <Icon
                      name={step.done ? "lucide:check-square" : "lucide:square"}
                      size={15}
                      color={step.done ? palette.success : palette.textDim}
                    />
                    <Text style={{ fontSize: fontSize.md, color: step.done ? palette.textDim : palette.text }}>
                      {step.title}
                    </Text>
                    {step.done ? null : (
                      <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>{step.description}</Text>
                    )}
                  </View>
                ))}
              </View>
              <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>
                做完这四步，别人就能在游戏里搜到你的服
              </Text>
              <Action
                label="去完成设置"
                icon="lucide:arrow-left"
                compact
                onPress={() => void navigate({ to: "/setup" })}
              />
            </Card>
          </View>
        ) : null}
      </PageScroll>
    );
  }

  return (
    <PageScroll style={{ gap: space.lg, padding: space.xl }}>
      <PageHeader
        title="服务器数据面板"
        icon="lucide:gauge"
        description={
          instance()?.hosted ? "服务器正在运行，日志和面板控制通道都接上了" : "服务器正在运行，但面板没接上它"
        }
        actions={
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Action label="查看日志" icon="lucide:list" onPress={() => void navigate({ to: "/server/logs" })} />
            <Action label="重启" icon="lucide:refresh-cw" onPress={() => void store.restartServer()} />
            <Action label="停止" icon="lucide:square" tone="danger" onPress={() => void store.stopServer()} />
          </View>
        }
      />

      <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
        <Stat
          label="运行时长"
          value={instance()?.startedAt ? formatDuration(instance()!.startedAt) : "—"}
          icon="lucide:clock"
          tone="info"
          hint={`启动于 ${instance()?.startedAt ? formatRelative(instance()!.startedAt) : "—"}`}
        />
        <Stat
          label="在线玩家"
          value={instance()?.metrics?.players ?? "0"}
          unit="人"
          icon="lucide:users"
          tone={(instance()?.metrics?.players ?? "0") !== "0" ? "success" : "neutral"}
        />
        <Stat
          label="占用内存"
          value={String(instance()?.workingSetMB ?? 0)}
          unit="MB"
          icon="lucide:hard-drive"
          hint={instance()?.privateMB ? `另有 ${instance()?.privateMB} MB 是它独占的` : undefined}
        />
        <Stat
          label="CPU"
          value={instance()?.cpuSeconds ? formatCpu(instance()!.cpuSeconds, instance()!.startedAt) : "—"}
          icon="lucide:cpu"
          hint={instance()?.metrics?.cpuPercent ? `服务器自报 ${instance()?.metrics?.cpuPercent}%` : undefined}
        />
        <Stat label="地图" value={instance()?.metrics?.map ?? store.settings().map ?? "—"} icon="lucide:layers" />
      </View>

      <View style={{ flexDirection: "row", gap: space.lg, minHeight: 0, flexGrow: 1 }}>
        <Card
          title="实时日志"
          icon="lucide:list"
          subtitle={store.logPath() ? "本次运行写下的记录" : "本次运行还没写记录"}
          tone="info"
          grow
          actions={
            <Action
              label="打开"
              icon="lucide:layout"
              variant="ghost"
              compact
              onPress={() => void navigate({ to: "/server/logs" })}
            />
          }
        >
          <View
            style={{
              flexGrow: 1,
              minHeight: 0,
              backgroundColor: palette.log,
              borderRadius: radius.md,
              padding: space.md,
              gap: 2,
            }}
          >
            {logTail().length === 0 ? (
              <Text style={{ color: palette.logDim, fontSize: fontSize.sm }}>等待服务器输出…</Text>
            ) : (
              logTail().map((line) => (
                <Text style={{ fontFamily: font.mono, fontSize: fontSize.sm, color: palette.logLine }}>{line}</Text>
              ))
            )}
          </View>
        </Card>

        <View style={{ width: 360, gap: space.lg, flexShrink: 0 }}>
          <Card title="运行中的服务器" icon="lucide:cpu" tone="accent">
            <View style={{ gap: space.sm }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: palette.success }} />
                <Text style={{ fontSize: fontSize.md, color: palette.success }}>运行中</Text>
                <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>进程号 {instance()?.pid}</Text>
              </View>
              <Separator />
              <InfoRow label="版本" value={instance()?.version ?? "—"} />
              <InfoRow label="端口" value={`UDP ${instance()?.port ?? "—"}`} />
              <InfoRow
                label="控制通道"
                value={instance()?.hosted ? "已接上，能发指令" : "面板没接上"}
                tone={instance()?.hosted ? "success" : "warning"}
              />
              <InfoRow label="监听地址" value={instance()?.endpoints.join(" ") || "还没读出来"} />
            </View>
          </Card>

          <Card
            title="本次运行情况"
            icon="lucide:heart"
            tone={errorBytes() === 0 ? "success" : "danger"}
            actions={
              <Action label="详情" variant="ghost" compact onPress={() => void navigate({ to: "/ops/health" })} />
            }
          >
            {health() ? (
              <View style={{ gap: space.sm }}>
                <InfoRow
                  label="错误记录"
                  value={errorBytes() === 0 ? "没有记录错误，一切正常" : "有错误记录，需要处理"}
                  tone={errorBytes() === 0 ? "success" : "danger"}
                />
                <InfoRow
                  label="本次运行编号"
                  value={health()?.runId ? shortId(health()!.runId) : "读不到运行记录"}
                  mono
                />
                {health()?.notes.length ? <Note tone="warning" text={health()?.notes.join("　") ?? ""} /> : null}
              </View>
            ) : (
              <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>正在读取…</Text>
            )}
          </Card>
        </View>
      </View>
    </PageScroll>
  );
}
