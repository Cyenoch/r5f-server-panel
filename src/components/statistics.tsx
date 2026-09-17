import { Text, View, type SolidChild } from "@solid-gpui/core";
import { LineChart } from "@solid-gpui/core/components";
import { createMemo, createSignal } from "@solid-gpui/core/runtime";
import { DEV_MODE } from "#server/panel";
import { playerCounts, type MetricSample } from "#server/telemetry";
import { session } from "../lib/session";
import { fontSize, palette, space } from "../lib/theme";
import { Action, Card, EmptyHint, Note, Stat, Toolbar } from "./ui";

type MetricKey = "players" | "memoryMB" | "cpuPercent" | "frameMs";
const METRICS: { key: MetricKey; label: string; unit: string; color: string }[] = [
  { key: "players", label: "在线玩家", unit: "人", color: palette.success },
  { key: "memoryMB", label: "内存占用", unit: "MB", color: palette.info },
  { key: "cpuPercent", label: "进程 CPU", unit: "% / 单核", color: palette.primary },
  { key: "frameMs", label: "服务器帧耗时", unit: "ms", color: palette.warning },
];

function Trend(props: { samples: MetricSample[]; metric: (typeof METRICS)[number] }): SolidChild {
  // Plot only the newest uninterrupted observed segment; do not draw through offline gaps.
  const points = createMemo(() => {
    let start = props.samples.length - 1;
    while (start >= 0 && props.samples[start][props.metric.key] === null) start--;
    if (start < 0) return [];
    const end = start + 1;
    while (
      start > 0 &&
      props.samples[start - 1][props.metric.key] !== null &&
      props.samples[start].at - props.samples[start - 1].at < 30_000
    )
      start--;
    const segment = props.samples.slice(start, end);
    const step = Math.max(1, Math.ceil(segment.length / 90));
    return segment
      .filter((_, index) => index % step === 0 || index === segment.length - 1)
      .map((sample) => ({
        label: new Date(sample.at).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
        value: sample[props.metric.key]!,
      }));
  });
  return (
    <View style={{ flexGrow: 1, width: 0, minWidth: 280, gap: space.sm }}>
      <Card title={props.metric.label} subtitle={props.metric.unit}>
        {points().length < 2 ? (
          <View style={{ height: 160, justifyContent: "center", alignItems: "center" }}>
            <Text style={{ color: palette.textDim, fontSize: fontSize.sm }}>
              {points().length ? "等待下一个有效采样点…" : "暂无观测数据"}
            </Text>
          </View>
        ) : (
          <LineChart
            data={points()}
            name={props.metric.label}
            stroke={props.metric.color}
            curve="linear"
            xAxis
            grid
            interactive
            style={{ height: 160, flexGrow: 1 }}
          />
        )}
      </Card>
    </View>
  );
}

export function Statistics(props: { instanceId?: string }): SolidChild {
  const store = session();
  const [hours, setHours] = createSignal(1);
  const rows = () =>
    props.instanceId ? store.fleet().filter((row) => row.instance.id === props.instanceId) : store.fleet();
  const samples = createMemo(() => store.history(props.instanceId ?? null, hours()));
  const latest = () => samples().at(-1);
  const live = () => rows().filter((row) => row.metrics?.alive);
  const players = () => {
    const counts = rows().map((row) => playerCounts(row.metrics));
    return counts.some((count) => count.players === null)
      ? null
      : counts.reduce((sum, count) => sum + count.players!, 0);
  };
  const capacity = () => {
    const counts = rows().map((row) => playerCounts(row.metrics));
    return counts.some((count) => count.capacity === null)
      ? null
      : counts.reduce((sum, count) => sum + count.capacity!, 0);
  };
  const peak = () => {
    const known = samples().flatMap((sample) => (sample.players === null ? [] : [sample.players]));
    return known.length ? Math.max(...known) : null;
  };
  return (
    <View style={{ flexDirection: "column", gap: space.lg, minWidth: 0 }}>
      {store.refreshError() ? (
        <Note tone="warning" text={`采集失败，下面可能是旧数据：${store.refreshError()}`} />
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        <Stat
          label={props.instanceId ? "实例状态" : "运行实例"}
          value={
            props.instanceId
              ? live().length
                ? "运行中"
                : "已停止"
              : `${live().length} / ${store.state().instances.length}`
          }
          icon="lucide:cpu"
          tone={live().length ? "success" : "neutral"}
          hint={props.instanceId ? "来自进程存活检查" : "运行中 / 已创建"}
        />
        <Stat
          label="在线玩家"
          value={players() === null ? "—" : String(players())}
          unit="人"
          icon="lucide:users"
          tone="info"
          hint={capacity() === null ? "服务器未返回人数" : `当前容量 ${capacity()} 人`}
        />
        <Stat
          label="观测峰值"
          value={peak() === null ? "—" : String(peak())}
          unit="人"
          icon="lucide:gauge"
          hint={`最近 ${hours()} 小时内有效采样`}
        />
        <Stat
          label="内存占用"
          value={
            live().length ? (live().reduce((sum, row) => sum + row.metrics!.workingSetMB, 0) / 1024).toFixed(2) : "0"
          }
          unit="GB"
          icon="lucide:hard-drive"
          hint="运行实例工作集总和"
        />
      </View>
      <Toolbar>
        <Text style={{ fontSize: fontSize.lg, color: palette.text, fontWeight: "semibold" }}>运行趋势</Text>
        <View style={{ flexGrow: 1 }} />
        {[1, 6, 24].map((value) => (
          <Action
            label={`${value} 小时`}
            compact
            tone={hours() === value ? "info" : "neutral"}
            variant={hours() === value ? "solid" : "ghost"}
            onPress={() => setHours(value)}
          />
        ))}
      </Toolbar>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        {METRICS.slice(0, 2).map((metric) => (
          <Trend metric={metric} samples={samples()} />
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        {METRICS.slice(2).map((metric) => (
          <Trend metric={metric} samples={samples()} />
        ))}
      </View>
      <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
        {`${DEV_MODE ? "模拟环境 · " : ""}面板打开期间每 10 秒采样，保留 24 小时。CPU 100% 表示占满一个逻辑核心；总览帧耗时取实例最大值。曲线只绘制最近连续有效区间，不填补缺测。${latest() ? `最后采样 ${new Date(latest()!.at).toLocaleTimeString("zh-CN")}` : "尚未采样。"}`}
      </Text>
      {!props.instanceId && store.state().instances.length === 0 ? (
        <EmptyHint
          icon="lucide:layers"
          title="从一个实例开始"
          description="先安装服务端版本，再创建实例并选择玩法模板。采集到数据后，趋势会自动出现。"
        />
      ) : null}
    </View>
  );
}
