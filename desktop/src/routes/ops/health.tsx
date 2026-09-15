import { triggerLabel, type HostFacts } from "@server/inspect";
/**
 * 体检：一台机器能不能跑服，看三块 —— 本次运行有没有报错、主机本身够不够格、系统层面还缺哪些设置。
 * 三块数据都来自会话 store 的慢轮询（30 秒一次），页面自己不发探测器调用。
 * 口径只有一条：没读到就说没读到，`error.log` 非空就不能说健康。
 *
 * 布局：外壳的内容区（shell.tsx 的 `height: 0 / flexGrow: 1`）没有滚动容器，
 * 所以页面根在契约的列骨架之外自己带 `overflow: "scroll"` —— 三张卡片比视口高，
 * 不滚动的话「主机能力」整块都滚不出来。页面根仍被视口限高，不会出现双滚动条。
 */
import { Text, View, type SolidChild } from "@solid-gpui/core";
import { createFileRoute } from "@solid-gpui/router";
import { Action, Card, Chip, EmptyHint, KeyValueList, Note, PageHeader, PageScroll } from "../../components/ui";
import { formatBytes, shortId } from "../../lib/format";
import { session } from "../../lib/session";
import { font, fontSize, palette, radius, space } from "../../lib/theme";

export const Route = createFileRoute("/ops/health")({ component: Page });

/** error.log 最多摆这么多行：它的头部就够定位，全文去实时日志页看。 */
const ERROR_LINES = 12;

const LOG_BOX = {
  backgroundColor: palette.log,
  borderRadius: radius.md,
  padding: space.md,
  gap: 2,
  minWidth: 0,
} as const;

/** 主机实况里还差的东西：一句人话，配一个下一步；一项不缺就返回空串。 */
function hostNote(facts: HostFacts, port: number): string {
  const items: string[] = [];
  if (facts.portInUse) items.push(`UDP ${port} 被别的程序占了，服务器起不来（换个端口，或关掉占用它的程序）`);
  if (facts.pageInitMB === 0) items.push("页面文件还没设置（服务器容易在内存吃紧时崩掉）");
  if (!facts.defenderExcluded) items.push("杀毒软件还没排除服务器目录（可能拖慢、误删文件）");
  if (facts.taskState.length === 0) items.push("还没配开机自启（机器重启后要你手动开服）");
  if (!facts.powerHighPerformance) items.push("电源计划不是高性能（换图、加载会慢）");
  if (items.length === 0) return "";
  return `这台机器还有 ${items.length} 处要处理：${items.join("；")}。去「主机配置」页点「应用主机配置」可以一次都设好。`;
}

/** 本次运行的健康：先说结论，再摊开记录，最后给下一步。 */
function RunCard(): SolidChild {
  const store = session();
  const health = store.health;
  const error = () => health()?.error ?? null;
  const bytes = () => error()?.bytes ?? 0;
  const runId = () => health()?.runId ?? "";
  return (
    <Card
      title={
        error() === null
          ? "本次运行"
          : !error()!.exists
            ? "没找到记录（不能下结论）"
            : bytes() > 0
              ? "本次运行出现过错误"
              : "本次运行正常"
      }
      icon="lucide:heart"
      subtitle={health() === null ? undefined : "看的是这台服务器最近一次运行"}
      tone={error() === null ? "neutral" : !error()!.exists ? "warning" : bytes() > 0 ? "danger" : "success"}
    >
      {health() === null ? (
        <EmptyHint
          compact
          icon="lucide:refresh-cw"
          title="还没读到运行记录"
          description="体检结果每 30 秒自己刷一次，刚打开面板时可能还没到；也可以点右上角「重新检查」。"
        />
      ) : (
        <View style={{ gap: space.md, minWidth: 0 }}>
          {!error()!.exists ? (
            <Note
              tone="warning"
              text={
                store.versions().length === 0
                  ? "还没读到运行记录：这台机器上一个可用的服务端版本都没有。先去「启动引导」放一份，再回来看这里。"
                  : "没找到这台服务器留下的运行记录，可能它还没启动过。先在首页启动服务器，再回来点「重新检查」—— 没读到记录既不能说正常，也不能说有问题。"
              }
            />
          ) : bytes() > 0 ? (
            <View style={{ gap: space.sm, minWidth: 0 }}>
              <Note tone="danger" text={`本次运行出现过错误，记录里有 ${formatBytes(bytes())}。`} />
              <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>前几行是这些：</Text>
              <View style={LOG_BOX}>
                {error()!.lines.length === 0 ? (
                  <Text style={{ fontFamily: font.mono, fontSize: fontSize.sm, color: palette.logDim }}>
                    记录里有内容，但读不出能看的文字。
                  </Text>
                ) : (
                  error()!
                    .lines.slice(0, ERROR_LINES)
                    .map((line) => (
                      <Text style={{ fontFamily: font.mono, fontSize: fontSize.sm, color: palette.logError }}>
                        {line}
                      </Text>
                    ))
                )}
              </View>
              <Note
                tone="info"
                text="拿这段去搜，或者贴给帮忙的人看 —— 前半段通常就够定位问题；要完整原文，去实时日志页看。"
              />
            </View>
          ) : (
            <Note tone="success" text="本次运行正常：到现在为止没有记录到错误。" />
          )}

          <KeyValueList
            rows={[
              {
                label: "本次运行编号",
                value: runId().length > 0 ? shortId(runId()) : "没读到",
                tone: runId().length > 0 ? undefined : "warning",
                mono: true,
              },
              {
                label: "启动提示",
                value: health()!.warning.exists
                  ? `读到 ${health()!.warning.lines.length} 行 · 服务器启动时的自检输出，不是错误`
                  : "没有",
                tone: "neutral",
              },
              {
                label: "脚本提示",
                value: health()!.scriptWarning.exists
                  ? `读到 ${health()!.scriptWarning.lines.length} 行 · 脚本自己发的提醒，不影响启动`
                  : "没有",
                tone: "neutral",
              },
            ]}
          />

          <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
            运行编号截了前 8 位，给报障时对号用：把它一起发出去，就能对上是不是同一次运行。
          </Text>
        </View>
      )}
    </Card>
  );
}

/** 主机本身：内存/页面文件/磁盘/电源/排除项/自启/端口，全部读不到就说读不到。 */
function HostCard(): SolidChild {
  const store = session();
  const host = store.host;
  const port = () => store.settings().port;
  return (
    <Card title="这台机器" icon="lucide:hard-drive" tone="info" subtitle="面板刚读到的这台机器的状态">
      {host() === null ? (
        <EmptyHint
          compact
          icon="lucide:refresh-cw"
          title="还没读到这台机器的信息"
          description="要等面板读一次，最多 30 秒；也可以点右上角「重新检查」。"
        />
      ) : (
        <View style={{ gap: space.md, minWidth: 0 }}>
          <KeyValueList
            rows={[
              { label: "内存", value: `${host()!.ramGB} GB` },
              {
                label: "页面文件",
                value:
                  host()!.pageInitMB === -1
                    ? "系统托管"
                    : host()!.pageInitMB === 0
                      ? "未设置"
                      : `${host()!.pageInitMB} MB`,
                tone: host()!.pageInitMB === 0 ? "warning" : undefined,
              },
              { label: "剩余磁盘", value: `${host()!.diskFreeGB} GB` },
              {
                label: "电源计划",
                value: host()!.powerHighPerformance ? "高性能" : "不是高性能（换图、加载会慢）",
                tone: host()!.powerHighPerformance ? "success" : "warning",
              },
              {
                label: "杀毒软件排除",
                value: host()!.defenderExcluded ? "已排除服务器目录" : "未排除服务器目录",
                tone: host()!.defenderExcluded ? "success" : "warning",
              },
              {
                label: "开机自启",
                value: host()!.taskState.length > 0 ? `已配置${triggerLabel(host()!.taskTrigger)}` : "未配置",
                tone: host()!.taskState.length > 0 ? "success" : "warning",
              },
              {
                label: "游戏端口",
                value: host()!.portInUse ? `UDP ${port()} 已被占用` : `UDP ${port()} 空闲`,
                tone: host()!.portInUse ? "danger" : "success",
              },
            ]}
          />
          {hostNote(host()!, port()) !== "" ? <Note tone="warning" text={hostNote(host()!, port())} /> : null}
        </View>
      )}
    </Card>
  );
}

/** 系统层面还缺哪些设置：每一项都是真探到的勾选状态，不是「建议做到」。 */
function CapabilityCard(): SolidChild {
  const store = session();
  const capabilities = store.capabilities;
  return (
    <Card
      title="系统设置"
      icon="lucide:check-square"
      tone="accent"
      subtitle="开服要做的系统侧设置，逐项看现在是生效还是没生效"
      actions={
        <Action
          label="重新检查"
          icon="lucide:refresh-cw"
          variant="ghost"
          compact
          onPress={() => void store.refreshSlow(true)}
        />
      }
    >
      {capabilities().length === 0 ? (
        <EmptyHint
          compact
          icon="lucide:triangle-alert"
          title="还没读到这份清单"
          description="这次检查没回来。点「重新检查」再试一次；要改这些设置，去「主机配置」页。"
        />
      ) : (
        <View style={{ gap: space.sm, minWidth: 0 }}>
          {capabilities().map((capability) => (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.md,
                padding: space.md,
                backgroundColor: palette.panelRaised,
                borderRadius: radius.md,
                minWidth: 0,
              }}
            >
              <Chip
                tone={capability.enabled ? "success" : "warning"}
                label={capability.enabled ? "已生效" : "未生效"}
                icon={capability.enabled ? "lucide:check" : "lucide:x"}
              />
              <View style={{ gap: 2, flexGrow: 1, minWidth: 0 }}>
                <Text style={{ fontSize: fontSize.md, color: palette.text }}>{capability.label}</Text>
                <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>{capability.detail}</Text>
              </View>
            </View>
          ))}
          <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
            「未生效」的项去「主机配置」页点「应用主机配置」一次设好；改完回这里点「重新检查」。
          </Text>
        </View>
      )}
    </Card>
  );
}

function Page(): SolidChild {
  const store = session();
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
        title="体检"
        icon="lucide:heart"
        description="这台机器和这次运行的健康情况。跑不起来、玩家连不上、换图卡，先看这一页。"
        actions={
          <Action
            label="重新检查"
            icon="lucide:refresh-cw"
            onPress={() => void store.refreshSlow(true)}
            disabled={store.busy() !== null}
          />
        }
      />
      <RunCard />
      <HostCard />
      <CapabilityCard />
    </PageScroll>
  );
}
