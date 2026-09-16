/**
 * `/server/list` —— 服务器列表：本机所有服务端版本，卡片上直接启动。
 *
 * 两处引擎模型决定了这页的写法，别改回去：
 *  1. 启动哪个版本只由 `state.current` 决定（`startServer` 不接受版本参数），
 *     所以卡片上的「启动」会先把当前版本切到这张卡片，再开对话框 —— 否则会出现
 *     "点 A 卡片的启动、起来的却是 B"。
 *  2. 启动对话框里选档案 = 把档案的 settings 复制进当前生效设置（不是一次性参数），
 *     所以选完立刻生效、取消也不回滚；界面必须把这一点写出来，不能假装是草稿。
 */
import { Icon, Pressable, Text, View, type SolidChild } from "@solid-gpui/core";
import { Dialog, Input } from "@solid-gpui/core/components";
import { createSignal } from "@solid-gpui/core/runtime";
import { createFileRoute, useNavigate } from "@solid-gpui/router";
import {
  Action,
  Card,
  Chip,
  EmptyHint,
  Fold,
  Help,
  KeyValueList,
  Note,
  PageHeader,
  SectionTitle,
  StatusDot,
  Toolbar,
  PageScroll,
} from "../../components/ui";
import { formatBytes } from "../../lib/format";
import { session } from "../../lib/session";
import { font, fontSize, palette, radius, space } from "../../lib/theme";

export const Route = createFileRoute("/server/list")({ component: Page });

/** busy 标签：界面要能分辨「正在扫描」和「正在启动」（与 `lib/session` 的动作名一致）。 */
const SCAN_LABEL = "刷新服务端列表";
const LAUNCH_LABEL = "启动服务器";

function Page(): SolidChild {
  const store = session();
  const navigate = useNavigate();

  const [open, setOpen] = createSignal(false);
  const [port, setPort] = createSignal("");
  const [map, setMap] = createSignal("");
  const [hostname, setHostname] = createSignal("");
  const [problem, setProblem] = createSignal("");

  const versions = store.versions;
  const settings = store.settings;
  const current = () => store.state().current;
  const instance = store.instance;

  function openStartDialog(version: string): void {
    if (current() !== version) store.useVersion(version);
    setPort("");
    setMap("");
    setHostname("");
    setProblem("");
    setOpen(true);
  }

  async function launch(): Promise<void> {
    if (store.busy() !== null) return;
    const rawPort = port().trim();
    let portOverride: number | undefined;
    if (rawPort.length > 0) {
      const parsed = Number(rawPort);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        setProblem("端口要填 1–65535 的整数；留空就用设置里的值。");
        return;
      }
      portOverride = parsed;
    }
    const rawMap = map().trim();
    const rawHostname = hostname().trim();
    setProblem("");
    // 只把用户真的填了的项当覆盖传下去，空控件 ≠ 空字符串。
    const result = await store.startServer({
      port: portOverride,
      map: rawMap.length > 0 ? rawMap : undefined,
      hostname: rawHostname.length > 0 ? rawHostname : undefined,
    });
    if (result?.ok) {
      setOpen(false);
      void navigate({ to: "/server/logs" });
    }
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
        title="服务器列表"
        icon="lucide:layers"
        description="这台电脑上装好的服务端，选一个就能开服。"
        actions={
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Action
              label="刷新"
              icon="lucide:refresh-cw"
              disabled={store.busy() !== null}
              tooltip="重新找一遍这台电脑上的服务端（顺便算占用空间）"
              onPress={() => void store.run(SCAN_LABEL, () => store.refreshVersions(true))}
            />
            <Action
              label="启动服务器"
              icon="lucide:play"
              tone="info"
              variant="solid"
              disabled={versions().length === 0 || current() === null}
              tooltip={
                versions().length === 0
                  ? "还没找到可用的服务端"
                  : current() === null
                    ? "先在下面任一张卡片上点「使用」选一个版本"
                    : undefined
              }
              onPress={() => {
                const name = current();
                if (name !== null) openStartDialog(name);
              }}
            />
          </View>
        }
      />

      {versions().length > 0 ? (
        <View style={{ gap: space.md }}>
          {versions().map((version) => {
            const isCurrent = current() === version.name;
            const isRunning = instance()?.alive === true && instance()?.version === version.name;
            const rows = [
              {
                label: "占用空间",
                value: version.sizeBytes >= 0 ? formatBytes(version.sizeBytes) : "还没统计（点右上「刷新」）",
              },
              ...(version.build.length > 0 ? [{ label: "版本号", value: version.build }] : []),
            ];
            return (
              <Card
                title={version.name}
                icon="lucide:package"
                tone={isCurrent ? "info" : "neutral"}
                actions={
                  <Toolbar>
                    <Action
                      label="使用"
                      icon="lucide:check"
                      compact
                      disabled={isCurrent}
                      tooltip={isCurrent ? "已经是当前版本" : "把当前版本切到它"}
                      onPress={() => store.useVersion(version.name)}
                    />
                    <Action
                      label="启动"
                      icon="lucide:play"
                      tone="info"
                      variant="solid"
                      compact
                      onPress={() => openStartDialog(version.name)}
                    />
                  </Toolbar>
                }
              >
                <View style={{ gap: space.md }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, flexWrap: "wrap" }}>
                    {isRunning ? (
                      <StatusDot tone="success" label="运行中" />
                    ) : (
                      <StatusDot tone="neutral" label="已停止" />
                    )}
                    {isCurrent ? <Chip tone="info" icon="lucide:check" label="当前版本" /> : null}
                  </View>
                  <KeyValueList rows={rows} />
                  <Fold label="文件夹位置">
                    <Text style={{ fontSize: fontSize.sm, color: palette.textDim, fontFamily: font.mono }}>
                      {version.path}
                    </Text>
                  </Fold>
                </View>
              </Card>
            );
          })}
        </View>
      ) : store.busy() === SCAN_LABEL ? (
        <View style={{ flexGrow: 1, minHeight: 0, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: fontSize.md, color: palette.textDim }}>正在找这台电脑上的服务端…</Text>
        </View>
      ) : (
        <EmptyHint
          icon="lucide:package"
          title="还没找到服务端"
          description="把解压好的服务端文件夹放进面板所在目录，里面要有启动必需的文件（r5apex_ds.exe、server.dll、loader.dll），然后点右上「刷新」。"
        />
      )}

      <Dialog
        open={open()}
        title={current() !== null ? `启动服务器 · ${current()}` : "启动服务器"}
        width={560}
        buttons={{ okText: "启动", cancelText: "取消", okVariant: "primary", showCancel: true, closeOnOk: false }}
        onAction={(action) => {
          if (action.kind === "ok") void launch();
          else setOpen(false);
        }}
        onOpenChange={(event) => {
          if (!event.open) setOpen(false);
        }}
      >
        <View style={{ gap: space.lg }}>
          <View style={{ gap: space.sm }}>
            <SectionTitle
              text="1 · 选一套配置"
              icon="lucide:sliders-horizontal"
              actions={<Help text="点一下就生效：这套设置会变成当前设置；启动时点取消也不会把它改回去。" />}
            />
            {store.profiles().length === 0 ? (
              <Text style={{ fontSize: fontSize.md, color: palette.textDim }}>
                还没存过配置，会直接用现在这份设置启动。
              </Text>
            ) : (
              <View style={{ gap: space.xs, maxHeight: 200 }}>
                {store.profiles().map((profile) => {
                  const active = profile.name === store.state().currentProfile;
                  return (
                    <Pressable
                      disabled={active}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: space.md,
                        padding: space.md,
                        backgroundColor: active ? palette.infoSoft : palette.panelRaised,
                        borderWidth: 1,
                        borderColor: active ? palette.info : palette.borderSoft,
                        borderRadius: radius.md,
                        minWidth: 0,
                      }}
                      onPress={() => {
                        if (!active) void store.activateProfile(profile.name);
                      }}
                    >
                      <Icon
                        name={active ? "lucide:check-square" : "lucide:square"}
                        size={15}
                        color={active ? palette.info : palette.textDim}
                      />
                      <View style={{ flexGrow: 1, minWidth: 0 }}>
                        <Text style={{ fontSize: fontSize.md, color: palette.text }}>{profile.name}</Text>
                        <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>{profile.summary}</Text>
                      </View>
                      {active ? <Chip tone="info" icon="lucide:clock" label="上次使用" /> : null}
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>

          <View style={{ gap: space.sm }}>
            <SectionTitle text="2 · 只改这一次（可选）" icon="lucide:sliders-horizontal" />
            <View style={{ gap: space.xs, minWidth: 0 }}>
              <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>端口</Text>
              <Input value={port()} placeholder={String(settings().port)} onChange={(event) => setPort(event.value)} />
            </View>
            <View style={{ gap: space.xs, minWidth: 0 }}>
              <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>地图</Text>
              <Input value={map()} placeholder={settings().map} onChange={(event) => setMap(event.value)} />
            </View>
            <View style={{ gap: space.xs, minWidth: 0 }}>
              <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>服务器名</Text>
              <Input
                value={hostname()}
                placeholder={settings().hostname}
                onChange={(event) => setHostname(event.value)}
              />
            </View>
            <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
              留空 = 用设置里的值；这三项只影响这一次启动，不写回设置。
            </Text>
          </View>

          {problem().length > 0 ? <Note tone="danger" text={problem()} /> : null}
          {store.busy() === LAUNCH_LABEL ? <Note tone="info" text="正在启动…" /> : null}
        </View>
      </Dialog>
    </PageScroll>
  );
}
