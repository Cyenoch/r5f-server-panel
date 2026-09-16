import { type Capability, type CapabilityId, type HostFacts } from "@server/inspect";
/**
 * 主机配置：本机为跑专用服务器要做的系统侧设置（防火墙 / 页面文件 / Defender / 自启 / 电源）。
 *
 * 面板**不自己改系统设置** —— 「应用主机配置」重新跑一遍仓库自己的 CLI（`setup`），
 * 由它去提权、去改，输出原样进动作记录。页面只负责如实显示探测结果。
 *
 * 版式约定（UI 重做后）：这里就是**主机事实的唯一出处**（体检页只给结论 + 跳转过来）。
 * 本页把重复清掉了：清单给五项设置的状态，实况只留清单里没有的三条（内存 / 磁盘 / 端口占用），
 * 每一项的"开它有什么用"进悬停提示，不再各占一行正文。
 */
import { Text, View, type SolidChild } from "@solid-gpui/core";
import { createSignal } from "@solid-gpui/core/runtime";
import { createFileRoute } from "@solid-gpui/router";
import {
  Action,
  Card,
  Chip,
  Confirm,
  Help,
  IconAction,
  KeyValueList,
  Note,
  PageHeader,
  type KeyValueRow,
  PageScroll,
} from "../../components/ui";
import { session } from "../../lib/session";
import { fontSize, palette, radius, space } from "../../lib/theme";

export const Route = createFileRoute("/config/host")({ component: Page });

/**
 * 清单里每一条都答一句「开这个有什么用」：探测器给的是技术名词，
 * 服主需要知道的是开了它自己能拿到什么。这句话进悬停提示，不占正文。
 */
const CAPABILITY_HELP: Record<CapabilityId, string> = {
  firewall: "不放行，外面的玩家连不进来。",
  pagefile: "内存吃紧时不容易掉帧或崩服。",
  defender: "不让杀毒软件拖慢、误删服务器的文件。",
  task: "机器重启后服务器自己起来，不用你手动开。",
  power: "CPU 不降频，换图和加载不卡。",
};

/** 还差哪些系统设置：只要名字，用来凑一句汇总；一项不缺就是空数组。 */
function missingItems(facts: HostFacts): string[] {
  const items: string[] = [];
  if (facts.firewallMissing.length > 0) items.push("放行游戏端口");
  if (facts.pageInitMB === 0) items.push("固定页面文件大小");
  if (!facts.defenderExcluded) items.push("杀毒软件排除服务器目录");
  if (facts.taskState.length === 0) items.push("开机自启");
  if (!facts.powerHighPerformance) items.push("高性能电源计划");
  return items;
}

/** 一条能力：勾选状态来自真实探测，所以只读 —— 要改就整批走「应用主机配置」。 */
function CapabilityRow(props: { capability: Capability }): SolidChild {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        padding: space.md,
        borderRadius: radius.md,
        backgroundColor: props.capability.enabled ? palette.successSoft : palette.panelRaised,
        minWidth: 0,
      }}
    >
      <Chip
        tone={props.capability.enabled ? "success" : "warning"}
        label={props.capability.enabled ? "已生效" : "未生效"}
        icon={props.capability.enabled ? "lucide:check" : "lucide:x"}
      />
      <View style={{ flexGrow: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text style={{ fontSize: fontSize.md, color: palette.text }}>{props.capability.label}</Text>
        <Text style={{ fontSize: fontSize.sm, color: palette.textDim, flexShrink: 1 }}>{props.capability.detail}</Text>
      </View>
      <Help text={CAPABILITY_HELP[props.capability.id]} />
    </View>
  );
}

/** 主机实况里**清单没有覆盖**的事实：内存、磁盘、端口占用。 */
function factRows(facts: HostFacts, port: number): KeyValueRow[] {
  return [
    { label: "内存", value: `${facts.ramGB} GB`, mono: true },
    { label: "磁盘剩余", value: `${facts.diskFreeGB} GB`, mono: true },
    {
      label: "游戏端口",
      value: facts.portInUse ? `UDP ${port} 已被占用（启动会失败）` : `UDP ${port} 空闲`,
      tone: facts.portInUse ? "danger" : "success",
    },
  ];
}

function Page(): SolidChild {
  const store = session();
  const [confirmApply, setConfirmApply] = createSignal(false);
  const capabilities = () => store.capabilities();
  const facts = () => store.host();
  const port = () => store.settings().port;
  const probing = () => capabilities().length === 0 && facts() === null;
  const probeFailed = () => capabilities().length > 0 && facts() === null;
  const missing = () => (facts() === null ? [] : missingItems(facts()!));

  async function applyHost(): Promise<void> {
    await store.runCli(["setup", "--ports", String(port())], "应用主机配置");
  }

  return (
    <PageScroll style={{ gap: space.lg, padding: space.xl }}>
      <PageHeader
        title="主机配置"
        icon="lucide:hard-drive"
        description={`让这台机器扛得住长时间开服（游戏端口 UDP ${port()}）。`}
        actions={
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <IconAction
              icon="lucide:refresh-cw"
              label="重新检查一遍这台机器"
              disabled={store.busy() !== null}
              onPress={() => void store.refreshSlow(true)}
            />
            <Action
              label="应用主机配置"
              icon="lucide:zap"
              tone="info"
              variant="solid"
              disabled={store.busy() !== null}
              onPress={() => setConfirmApply(true)}
            />
          </View>
        }
      />

      {probing() ? <Note text="正在检查这台机器，大概要几秒钟。" /> : null}
      {probeFailed() ? (
        <Note
          tone="danger"
          text="没读到这台机器的信息（可能被系统策略挡住或超时）：下面每一条都按「未生效」显示，不代表真的没配。点右上角刷新再试。"
        />
      ) : null}
      {missing().length > 0 ? (
        <Note tone="warning" text={`这台机器还差 ${missing().length} 项设置：${missing().join("、")}。`} />
      ) : null}

      <View style={{ flexDirection: "row", gap: space.lg, alignItems: "flex-start", minWidth: 0 }}>
        <View style={{ flexGrow: 1, minWidth: 0 }}>
          <Card
            title="系统侧清单"
            icon="lucide:check-square"
            tone="accent"
            subtitle="这里是只读探测结果，改动整批走「应用主机配置」"
          >
            {capabilities().length === 0 ? (
              <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>还没读到任何一项：点右上角刷新。</Text>
            ) : (
              <View style={{ gap: space.sm }}>
                {capabilities().map((capability) => (
                  <CapabilityRow capability={capability} />
                ))}
              </View>
            )}
          </Card>
        </View>

        <View style={{ width: 360, flexShrink: 0, minWidth: 0 }}>
          <Card
            title="这台机器"
            icon="lucide:monitor"
            subtitle={facts() === null ? "还没读到（点刷新再试）" : "面板刚读到的状态"}
          >
            {facts() === null ? (
              <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>读不到这台机器的信息。</Text>
            ) : (
              <KeyValueList rows={factRows(facts()!, port())} />
            )}
          </Card>
        </View>
      </View>

      {/* 会提权改系统设置的动作，先把要改的东西列清楚再问一次。 */}
      <Confirm
        open={confirmApply()}
        title="应用主机配置？"
        message={`会弹管理员授权，一次改这几项：放行 UDP ${port()}、固定页面文件大小、排除杀毒软件、加上开机自启、切到高性能电源计划。被拒绝或跳过的步骤会写进动作记录。`}
        confirmLabel="应用"
        onConfirm={() => {
          setConfirmApply(false);
          void applyHost();
        }}
        onCancel={() => setConfirmApply(false)}
      />
    </PageScroll>
  );
}
