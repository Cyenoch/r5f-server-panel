/**
 * 启动引导：第一次开服要做的四件事，一页四张卡。
 *
 * 步骤清单（标题/说明/完成与否）来自 `lib/nav` 的 `onboardingSteps`，与首页共用一份；
 * 这里只给每一步画控件，改文案不用改这个文件。
 *
 * 版式约定（UI 重做后）：卡片只放「这一步要的东西 + 一个动作」。
 * 过去的「下一步：…（第 N 步）」尾注、以及"这一步在做什么"的重复小字都删了 ——
 * 卡片标题已经带序号，下一页就在下面。
 *
 * 布局：页面根走 `PageScroll`（四张卡比视口高，滚动由它接管）。
 */
import { Text, View, type IconName, type SolidChild } from "@solid-gpui/core";
import { Input } from "@solid-gpui/core/components";
import { createMemo, createSignal } from "@solid-gpui/core/runtime";
import { createFileRoute, useNavigate } from "@solid-gpui/router";
import { Action, Card, Chip, FormRow, Help, KeyValueList, Note, PageHeader, PageScroll } from "../components/ui";
import { formatBytes } from "../lib/format";
import { onboardingSteps } from "../lib/nav";
import { session } from "../lib/session";
import { font, fontSize, palette, radius, space } from "../lib/theme";

export const Route = createFileRoute("/setup")({ component: Page });

const STEP_ICON: Record<string, IconName> = {
  version: "lucide:folder-open",
  name: "lucide:text-cursor-input",
  address: "lucide:globe",
  ports: "lucide:power",
};

/**
 * 第一步：本机有哪些服务端版本。
 * `listVersions` 只返回三件套齐全的目录，缺文件的目录会直接不出现，所以空列表 =
 * 「一个能用的版本都没有」，不是「扫描失败」。
 */
function VersionStep(): SolidChild {
  const store = session();
  const versions = store.versions;
  return (
    <View style={{ gap: space.sm, minWidth: 0 }}>
      {versions().length === 0 ? (
        <Note tone="warning" text="一个能用的版本都没有：把解压出来的服务端文件夹整个放进面板所在目录。" />
      ) : null}
      {versions().map((version) => (
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
          <View style={{ flexGrow: 1, minWidth: 0, gap: 2 }}>
            <Text style={{ fontSize: fontSize.md, color: palette.text, fontFamily: font.mono }}>{version.name}</Text>
            <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>
              {[
                version.build.length > 0 ? `构建 ${version.build}` : "版本信息不全",
                version.sizeBytes >= 0 ? formatBytes(version.sizeBytes) : "大小未统计",
              ].join(" · ")}
            </Text>
          </View>
          {store.state().current === version.name ? (
            <Chip tone="info" label="当前使用" icon="lucide:check" />
          ) : (
            <Action
              label="使用"
              icon="lucide:play"
              tone="info"
              variant="solid"
              compact
              onPress={() => store.useVersion(version.name)}
            />
          )}
        </View>
      ))}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, minWidth: 0 }}>
        <Action
          label="重新扫描"
          icon="lucide:refresh-cw"
          onPress={() => store.refreshVersions(true)}
          disabled={store.busy() !== null}
          tooltip="扫描面板目录下的服务端文件夹，按版本号从高到低排"
        />
      </View>
    </View>
  );
}

/**
 * 第二步/第三步共用的一行输入：值由页面持有（草稿不能随步骤清单一起重建，见 `Page` 里的说明），
 * 保存走设置接口（`FieldId` + 原文）。
 */
function SettingRow(props: {
  id: "hostname" | "hostip";
  value: string;
  onInput: (next: string) => void;
  placeholder: string;
  help?: string;
}): SolidChild {
  const store = session();
  return (
    <FormRow label={props.id === "hostname" ? "服务器名" : "公网地址"} help={props.help}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 0 }}>
        <View style={{ flexGrow: 1, minWidth: 0 }}>
          <Input value={props.value} placeholder={props.placeholder} onChange={(event) => props.onInput(event.value)} />
        </View>
        <Action
          label="保存"
          icon="lucide:check"
          tone="info"
          variant="solid"
          disabled={store.busy() !== null}
          onPress={() => void store.saveSettings([{ id: props.id, raw: props.value }])}
        />
      </View>
    </FormRow>
  );
}

function NameStep(props: { value: string; onInput: (next: string) => void }): SolidChild {
  return (
    <View style={{ gap: space.sm, minWidth: 0 }}>
      <SettingRow
        id="hostname"
        value={props.value}
        onInput={props.onInput}
        placeholder="例如 我的 1v1 服"
        help="留空就是没名字，玩家在服务器列表里只会看到一串地址。"
      />
    </View>
  );
}

function AddressStep(props: { value: string; onInput: (next: string) => void }): SolidChild {
  return (
    <View style={{ gap: space.sm, minWidth: 0 }}>
      <SettingRow
        id="hostip"
        value={props.value}
        onInput={props.onInput}
        placeholder="例如 203.0.113.10 或 203.0.113.10:37015"
        help="机器在路由器或云主机后面时必须填公网 IP：服务器不知道自己的对外地址，会把内网地址报出去，外面探测不到就不会出现在列表里。公网端口与游戏端口不同时写成 公网IP:端口。"
      />
    </View>
  );
}

/** 第四步：端口与防火墙。端口本身在「服务器配置」里改，这里只做放行与自查。 */
function PortStep(): SolidChild {
  const store = session();
  const facts = store.host;
  const port = () => store.settings().port;
  const missing = () => facts()?.firewallMissing ?? [];
  return (
    <View style={{ gap: space.sm, minWidth: 0 }}>
      <KeyValueList
        rows={[
          { label: "游戏端口", value: `UDP ${port()}`, tone: "info", mono: true },
          {
            label: "防火墙放行",
            value:
              facts() === null
                ? "还没读到"
                : missing().length === 0
                  ? `已放行 UDP ${port()}`
                  : `缺少放行：UDP ${missing().join("、")}`,
            tone: facts() === null ? "neutral" : missing().length === 0 ? "success" : "warning",
          },
        ]}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, minWidth: 0 }}>
        <Action
          label="放行端口"
          icon="lucide:power"
          tone="warning"
          variant="solid"
          disabled={store.busy() !== null}
          tooltip="会弹管理员授权：一次把防火墙放行、页面文件、杀毒软件排除、开机自启、电源计划都设好"
          onPress={() => void store.runCli(["setup", "--ports", String(port())], "放行 UDP 端口")}
        />
      </View>
      <Note tone="warning" text="云主机的安全组是另一套规则，面板改不了：要在云控制台单独放行同一个 UDP 端口。" />
    </View>
  );
}

function Page(): SolidChild {
  const store = session();
  const navigate = useNavigate();
  /** 两个输入框的草稿归页面持有：步骤卡片是跟着 store 反应式重建的，放里面会被重建清掉。 */
  const [hostnameDraft, setHostnameDraft] = createSignal(store.settings().hostname);
  const [hostipDraft, setHostipDraft] = createSignal(store.settings().hostip);
  /**
   * 步骤清单只认 key 与完成状态：store 每 30 秒换一次 capabilities 数组，若按引用比较，
   * 卡片列表（含输入框）会跟着重建一次 —— 正在输入的草稿和焦点都会丢。
   * 四个判定条件本身是布尔值，内容没变就不该重画。
   */
  const steps = createMemo(
    () =>
      onboardingSteps({
        hasVersion: store.versions().length > 0,
        hostnameSet: store.settings().hostname.trim().length > 0,
        hostipSet: store.settings().hostip.trim().length > 0,
        firewallConfigured: store.capabilities().some((item) => item.id === "firewall" && item.enabled),
      }),
    undefined,
    {
      equals: (prev, next) =>
        prev.length === next.length &&
        prev.every((step, index) => step.key === next[index].key && step.done === next[index].done),
    },
  );
  const done = createMemo(() => steps().filter((step) => step.done).length);
  const allDone = () => done() === steps().length;

  return (
    <PageScroll style={{ gap: space.lg, padding: space.xl }}>
      <PageHeader
        title="启动引导"
        icon="lucide:rocket"
        description="第一次开服的四步；做完这些，外面才能看到你的服务器。"
        actions={
          <Chip
            tone={allDone() ? "success" : "warning"}
            label={`已完成 ${done()}/${steps().length}`}
            icon={allDone() ? "lucide:check" : "lucide:clock"}
          />
        }
      />

      {steps().map((step, index) => (
        <Card
          title={`${index + 1}. ${step.title}`}
          icon={STEP_ICON[step.key] ?? "lucide:check-square"}
          tone={step.done ? "success" : "warning"}
          subtitle={step.description}
          actions={
            <Chip
              tone={step.done ? "success" : "warning"}
              label={step.done ? "完成" : "待办"}
              icon={step.done ? "lucide:check" : "lucide:clock"}
            />
          }
        >
          {step.key === "version" ? <VersionStep /> : null}
          {step.key === "name" ? <NameStep value={hostnameDraft()} onInput={setHostnameDraft} /> : null}
          {step.key === "address" ? <AddressStep value={hostipDraft()} onInput={setHostipDraft} /> : null}
          {step.key === "ports" ? <PortStep /> : null}
        </Card>
      ))}

      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, minWidth: 0 }}>
        <Action
          label="进入面板"
          icon="lucide:layout"
          tone="info"
          variant="solid"
          onPress={() => void navigate({ to: "/" })}
        />
        <Text style={{ flexGrow: 1, minWidth: 0, fontSize: fontSize.sm, color: palette.textDim }}>
          {allDone() ? "都做完了，去首页启动服务器。" : `还剩 ${steps().length - done()} 步，也可以先进面板回头再来。`}
        </Text>
        <Help text="标着「待办」的就是还没做完的那一步。" />
      </View>
    </PageScroll>
  );
}
