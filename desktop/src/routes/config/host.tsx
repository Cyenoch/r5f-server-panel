import { triggerLabel, type Capability, type CapabilityId, type HostFacts } from "@server/inspect";
/**
 * 主机配置：本机为跑专用服务器要做的系统侧设置（防火墙 / 页面文件 / Defender / 自启 / 电源）。
 *
 * 面板**不自己改系统设置** —— 「应用主机配置」重新跑一遍仓库自己的 CLI（`setup`），
 * 由它去提权、去改，输出原样进动作记录。页面只负责如实显示探测结果。
 */
import { Text, View, type SolidChild } from "@solid-gpui/core";
import { Checkbox } from "@solid-gpui/core/components";
import { createFileRoute } from "@solid-gpui/router";
import { Action, Card, KeyValueList, Note, PageHeader, type KeyValueRow, PageScroll } from "../../components/ui";
import { session } from "../../lib/session";
import { fontSize, palette, radius, space } from "../../lib/theme";

export const Route = createFileRoute("/config/host")({ component: Page });

/**
 * 清单里每一条都答一句「开这个有什么用」：探测器给的是技术名词，
 * 服主需要知道的是开了它自己能拿到什么。
 */
const CAPABILITY_TEXT: Record<CapabilityId, { title: string; benefit: string }> = {
  firewall: { title: "放行游戏端口", benefit: "不放行，外面的玩家连不进来。" },
  pagefile: { title: "固定页面文件大小", benefit: "内存吃紧时不容易掉帧或崩服。" },
  defender: { title: "杀毒软件排除服务器目录", benefit: "不让杀毒软件拖慢、误删服务器的文件。" },
  task: { title: "开机自启", benefit: "机器重启后服务器自己起来，不用你手动开。" },
  power: { title: "高性能电源计划", benefit: "CPU 不降频，换图和加载不卡。" },
};

/** 还差哪些系统设置：一句人话 + 一个下一步；一项不缺就返回空串。 */
function missingNote(facts: HostFacts): string {
  const items: string[] = [];
  if (facts.firewallMissing.length > 0) items.push("放行游戏端口");
  if (facts.pageInitMB === 0) items.push("固定页面文件大小");
  if (!facts.defenderExcluded) items.push("杀毒软件排除服务器目录");
  if (facts.taskState.length === 0) items.push("开机自启");
  if (!facts.powerHighPerformance) items.push("高性能电源计划");
  if (items.length === 0) return "";
  return `这台机器还差 ${items.length} 项设置：${items.join("、")}。点「应用主机配置」可以一次都设好。`;
}

/** 一条能力：勾选状态来自真实探测，所以只读 —— 要改就整批走「应用主机配置」。 */
function CapabilityRow(props: { capability: Capability }): SolidChild {
  const text = CAPABILITY_TEXT[props.capability.id];
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: space.md,
        padding: space.md,
        borderRadius: radius.md,
        backgroundColor: props.capability.enabled ? palette.successSoft : palette.panelRaised,
        minWidth: 0,
      }}
    >
      <View style={{ paddingTop: 2 }}>
        <Checkbox
          checked={props.capability.enabled}
          disabled
          accessibilityLabel={text.title}
          tooltip="勾选是这台机器现在的状态；要改这些设置走「应用主机配置」"
        />
      </View>
      <View style={{ flexGrow: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ fontSize: fontSize.md, color: palette.text }}>{text.title}</Text>
        <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>{text.benefit}</Text>
        <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>{props.capability.detail}</Text>
      </View>
    </View>
  );
}

/** 主机实况：面板刚读到的事实，读不到就写读不到。 */
function factRows(facts: HostFacts, port: number): KeyValueRow[] {
  const pageFile =
    facts.pageInitMB === -1 ? "系统托管" : facts.pageInitMB === 0 ? "未配置" : `固定 ${facts.pageInitMB} MB`;
  return [
    { label: "内存", value: `${facts.ramGB} GB`, mono: true },
    { label: "页面文件", value: pageFile, tone: facts.pageInitMB > 0 ? "success" : "warning" },
    { label: "磁盘剩余", value: `${facts.diskFreeGB} GB`, mono: true },
    {
      label: "电源计划",
      value: facts.powerHighPerformance ? "高性能" : "不是高性能（服务器容易掉帧）",
      tone: facts.powerHighPerformance ? "success" : "warning",
    },
    {
      label: "杀毒软件排除",
      value: facts.defenderExcluded ? "已排除服务器目录" : "未排除服务器目录",
      tone: facts.defenderExcluded ? "success" : "warning",
    },
    {
      label: "开机自启",
      value: facts.taskState.length > 0 ? `已配置${triggerLabel(facts.taskTrigger)}` : "未配置",
      tone: facts.taskState.length > 0 ? "success" : "warning",
    },
    {
      label: "游戏端口",
      value: facts.portInUse ? `UDP ${port} 已被占用（启动会失败）` : `UDP ${port} 空闲`,
      tone: facts.portInUse ? "danger" : "success",
    },
    {
      label: "防火墙放行",
      value: facts.firewallMissing.length === 0 ? "端口都放行了" : `还差：UDP ${facts.firewallMissing.join("、")}`,
      tone: facts.firewallMissing.length === 0 ? "success" : "warning",
    },
  ];
}

function Page(): SolidChild {
  const store = session();
  const capabilities = () => store.capabilities();
  const facts = () => store.host();
  const port = () => store.settings().port;
  const probing = () => capabilities().length === 0 && facts() === null;
  const probeFailed = () => capabilities().length > 0 && facts() === null;

  async function applyHost(): Promise<void> {
    await store.runCli(["setup", "--ports", String(port())], "应用主机配置");
  }

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
        title="主机配置"
        icon="lucide:hard-drive"
        description={`让这台机器扛得住长时间开服：放行游戏端口 UDP ${port()}、调好页面文件、排除杀毒软件干扰、开机自启、保持高性能。`}
        actions={
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
            <Action
              label="刷新"
              icon="lucide:refresh-cw"
              onPress={() => void store.refreshSlow(true)}
              disabled={store.busy() !== null}
              tooltip="重新检查一遍这台机器（几秒钟）"
            />
            <Action
              label="应用主机配置"
              icon="lucide:zap"
              tone="info"
              variant="solid"
              disabled={store.busy() !== null}
              onPress={() => void applyHost()}
            />
            <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>会弹管理员授权</Text>
          </View>
        }
      />

      <Note
        text={`点「应用主机配置」会一次把这台机器设好：放行游戏的 UDP ${port()}、固定页面文件大小、排除杀毒软件、加上开机自启、切到高性能电源计划。被拒绝或跳过的步骤都会写进动作记录 —— 面板不自己改系统设置。`}
      />

      {probing() ? <Note text="正在检查这台机器，大概要几秒钟。" /> : null}
      {probeFailed() ? (
        <Note
          tone="danger"
          text="没读到这台机器的信息，可能被系统策略挡住了，或者检查超时：下面每一条都按「未生效」显示，不代表真的没配。点「刷新」再试一次。"
        />
      ) : null}

      {facts() !== null && facts()!.portInUse ? (
        <Note
          tone="danger"
          text={`UDP ${port()} 被别的程序占用了，服务器会启动失败：换一个端口，或者先关掉占用它的程序，再点「刷新」。`}
        />
      ) : null}
      {facts() !== null && missingNote(facts()!) !== "" ? <Note tone="warning" text={missingNote(facts()!)} /> : null}

      <View style={{ flexDirection: "row", gap: space.lg, alignItems: "flex-start", minWidth: 0 }}>
        <View style={{ flexGrow: 1, minWidth: 0 }}>
          <Card
            title="系统侧清单"
            icon="lucide:check-square"
            tone="accent"
            subtitle="勾选是这台机器现在的状态；这里只读，改动整批走「应用主机配置」"
          >
            {capabilities().length === 0 ? (
              <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>
                还没读到任何一项：点右上角「刷新」再试一次。
              </Text>
            ) : (
              <View style={{ gap: space.sm }}>
                {capabilities().map((capability) => (
                  <CapabilityRow capability={capability} />
                ))}
              </View>
            )}
          </Card>
        </View>

        <View style={{ width: 380, flexShrink: 0, minWidth: 0 }}>
          <Card
            title="主机实况"
            icon="lucide:monitor"
            subtitle={facts() === null ? "还没读到（点「刷新」再试一次）" : "面板刚读到的这台机器的状态"}
          >
            {facts() === null ? (
              <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>
                读不到这台机器的信息：可能被系统策略挡住了，或者检查超时。点「刷新」再试一次。
              </Text>
            ) : (
              <KeyValueList rows={factRows(facts()!, port())} />
            )}
          </Card>
        </View>
      </View>
    </PageScroll>
  );
}
