/**
 * 模式与地图：服务端自带的玩法目录（`playlists_r5_patch.txt` 里带 `r5f_mode_*` 元数据的模式）。
 *
 * 版式约定（UI 重做后）：
 *  1. 一个模式一行：标识、名字、状态徽标、⋯ 菜单 —— 简介与统计（地图数、默认地图、分类）进悬停提示；
 *  2. 「立即切换」是弹窗：先选地图再切，不再拿清单第一张替用户决定；
 *  3. 地图清单从"每张图一张卡片 + 一个按钮"改成可点选的标签墙 + 一个动作，卡片墙只是噪音。
 *
 * 两条动作的语义没变：设为启动模式写设置（重启后生效），立即切换走控制通道（只对跑着的实例有意义）。
 */
import type { ModeEntry } from "@server/catalog";
import type { FieldId } from "@server/settings-fields";
import { Pressable, Text, View, type SolidChild } from "@solid-gpui/core";
import { Select } from "@solid-gpui/core/components";
import { createEffect, createMemo, createSignal } from "@solid-gpui/core/runtime";
import { createFileRoute } from "@solid-gpui/router";
import {
  Action,
  Card,
  Chip,
  EmptyHint,
  Fold,
  FormDialog,
  FormRow,
  Help,
  IconAction,
  Note,
  PageHeader,
  RowMenu,
  PageScroll,
  type RowMenuItem,
} from "../../components/ui";
import { session } from "../../lib/session";
import { font, fontSize, palette, radius, space } from "../../lib/theme";

export const Route = createFileRoute("/config/modes")({ component: Page });

/** 一个模式一行：当前启动模式 / 正在跑的模式都标出来，动作收进 ⋯ 菜单。 */
function ModeRow(props: { mode: ModeEntry; onSwitch: (mode: ModeEntry) => void }): SolidChild {
  const store = session();
  const launching = () => store.settings().playlist === props.mode.id;
  const live = () => {
    const metrics = store.instance();
    return metrics?.alive === true && metrics.metrics?.playlist === props.mode.id;
  };
  const alive = () => store.instance()?.alive === true;

  /** 设为启动模式：模式自带地图清单且当前地图不在里面时，顺带把启动地图换成清单第一张。 */
  async function setLaunchMode(): Promise<void> {
    const settings = store.settings();
    const changes: { id: FieldId; raw: string }[] = [{ id: "playlist", raw: props.mode.id }];
    const first = props.mode.maps[0];
    const mapFallback = first !== undefined && !props.mode.maps.includes(settings.map) ? first : null;
    if (mapFallback !== null) changes.push({ id: "map", raw: mapFallback });
    if (!(await store.saveSettings(changes))) return;
    store.notice(
      "info",
      `已把启动模式设为 ${props.mode.id}`,
      mapFallback === null ? "重启服务器后生效" : `启动地图一并改为「${mapFallback}」，重启后生效`,
    );
  }

  const items = (): RowMenuItem[] => [
    {
      id: "launch",
      label: "设为启动模式",
      icon: "lucide:play",
      disabled: launching(),
      hint: launching() ? "已经是启动模式" : "写进启动设置，重启服务器后生效",
    },
    {
      id: "switch",
      label: "立即切换…",
      icon: "lucide:zap",
      disabled: !alive(),
      hint: alive() ? "让正在跑的服务器立刻换模式（玩家会掉一次线）" : "服务器没在跑",
    },
  ];

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        padding: space.sm,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: launching() ? palette.border : palette.borderSoft,
        backgroundColor: launching() ? palette.panelRaised : "#00000000",
        minWidth: 0,
      }}
    >
      <View style={{ flexGrow: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text style={{ fontSize: fontSize.md, fontWeight: "semibold", color: palette.text }}>{props.mode.title}</Text>
        <Text style={{ fontSize: fontSize.sm, fontFamily: font.mono, color: palette.textDim }}>{props.mode.id}</Text>
        {launching() ? <Chip tone="info" label="启动模式" icon="lucide:play" /> : null}
        {live() ? <Chip tone="success" label="运行中" icon="lucide:check" /> : null}
        <Help text={props.mode.blurb.length > 0 ? props.mode.blurb : "这个玩法没有写简介"} />
        <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
          {`${props.mode.maps.length} 张地图 · 默认 ${props.mode.map.length > 0 ? props.mode.map : "未声明"}`}
        </Text>
      </View>
      <RowMenu
        label={`${props.mode.title} 的操作`}
        items={items()}
        onSelect={(id) => {
          if (id === "launch") void setLaunchMode();
          if (id === "switch") props.onSwitch(props.mode);
        }}
      />
    </View>
  );
}

/** 地图浏览器：可点选的标签墙 + 一个动作，取代"每张图一张卡片 + 一个按钮"。 */
function MapBrowser(): SolidChild {
  const store = session();
  const [pickedMode, setPickedMode] = createSignal<string | null>(null);
  const [pickedMap, setPickedMap] = createSignal<string | null>(null);

  const modes = () => store.families().flatMap((family) => family.modes);
  const current = () => {
    const list = modes();
    if (list.length === 0) return null;
    const wanted = pickedMode() ?? store.settings().playlist;
    return list.find((mode) => mode.id === wanted) ?? list[0];
  };
  const maps = () => current()?.maps ?? [];
  const launchMap = () => store.settings().map;
  /** 选中的图：用户点过就用它，否则跟着当前启动地图（在清单里时）。 */
  const selected = () => {
    const explicit = pickedMap();
    if (explicit !== null) return explicit;
    return maps().includes(launchMap()) ? launchMap() : null;
  };

  /** Select 的选择项 key 必须非空且全局唯一：跨家族按模式 id 去重。 */
  const groups = () => {
    const seen = new Set<string>();
    return store.families().map((family, index) => ({
      key: `family-${index}`,
      label: family.title,
      items: family.modes
        .filter((mode) => {
          if (seen.has(mode.id)) return false;
          seen.add(mode.id);
          return true;
        })
        .map((mode) => ({ key: mode.id, label: `${mode.id} — ${mode.title}` })),
    }));
  };

  return (
    <Card title="地图清单" icon="lucide:layers" subtitle="点一张地图选中它，再设为启动地图；重启服务器后生效">
      <View style={{ minWidth: 280, maxWidth: 420 }}>
        <Select
          items={groups()}
          value={current()?.id}
          placeholder="选一个玩法"
          size="small"
          onChange={(change) => {
            if (change.value !== undefined && change.value !== null) {
              setPickedMode(change.value);
              setPickedMap(null);
            }
          }}
        />
      </View>
      {maps().length === 0 ? (
        <EmptyHint
          compact
          icon="lucide:layers"
          title="这个玩法没有列出地图"
          description="服务器会按它自己的顺序换图；想马上指定一张，去「服务器配置」手填地图名。"
        />
      ) : (
        <View style={{ flexDirection: "row", gap: space.xs, flexWrap: "wrap" }}>
          {maps().map((stem) => {
            const on = selected() === stem;
            const launching = launchMap() === stem;
            return (
              <Pressable
                onPress={() => setPickedMap(stem)}
                accessibilityRole="button"
                accessibilityLabel={launching ? `${stem}（当前启动地图）` : `选中地图 ${stem}`}
                tooltip={launching ? "当前启动地图" : "选中它，再点右边的「设为启动地图」"}
                style={{
                  paddingLeft: space.sm,
                  paddingRight: space.sm,
                  paddingTop: space.xs,
                  paddingBottom: space.xs,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: on ? palette.primary : palette.borderSoft,
                  backgroundColor: on ? palette.panelRaised : "#00000000",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.xs,
                }}
              >
                <Text
                  style={{
                    fontSize: fontSize.sm,
                    fontFamily: font.mono,
                    color: launching ? palette.success : on ? palette.text : palette.textMuted,
                  }}
                >
                  {stem}
                </Text>
                {launching ? <Chip tone="success" label="启动中" /> : null}
              </Pressable>
            );
          })}
        </View>
      )}
      <Action
        label="设为启动地图"
        icon="lucide:check"
        tone="info"
        variant="solid"
        compact
        disabled={selected() === null || selected() === launchMap()}
        tooltip={selected() === launchMap() ? "它已经是启动地图" : undefined}
        onPress={() => {
          const stem = selected();
          if (stem !== null) void store.saveSettings([{ id: "map", raw: stem }]);
        }}
      />
    </Card>
  );
}

/** 立即切换：模式 + 地图一步到位（`bridge_setmode`），弹窗里先把地图选清楚。 */
function SwitchDialog(props: { mode: ModeEntry | null; onClose: () => void }): SolidChild {
  const store = session();
  const [map, setMap] = createSignal("");
  const [problem, setProblem] = createSignal<string | null>(null);

  // 弹窗是同一个实例：换了模式就把地图选择清掉，免得上一个模式选的地图被带过来（它多半不在新清单里）。
  createEffect<string | null, string | null | undefined>((previous) => {
    const id = props.mode?.id ?? null;
    if (previous !== undefined && previous !== id) {
      setMap("");
      setProblem(null);
    }
    return id;
  }, undefined);

  const maps = () => props.mode?.maps ?? [];
  const choices = createMemo(() =>
    maps().length === 0 ? [] : [{ key: "maps", items: maps().map((name) => ({ key: name, label: name })) }],
  );

  const submit = async (): Promise<void> => {
    const mode = props.mode;
    if (!mode) return;
    if (maps().length > 0 && map().length === 0) {
      setProblem("先选一张地图。");
      return;
    }
    setProblem(null);
    await store.switchMode(mode.id, map().length > 0 ? map() : mode.map || maps()[0]);
    props.onClose();
  };

  return (
    <FormDialog
      open={props.mode !== null}
      title={`立即切换到 ${props.mode?.title ?? ""}`}
      okText="切换"
      okVariant="danger"
      problem={problem()}
      busy={store.busy() === "切换模式"}
      onClose={props.onClose}
      onOk={() => void submit()}
    >
      <FormRow label="模式">
        <Text style={{ fontSize: fontSize.md, fontFamily: font.mono, color: palette.text }}>
          {props.mode?.id ?? ""}
        </Text>
      </FormRow>
      <FormRow label="地图" help="换图期间所有在线玩家会掉一次线。">
        <Select
          accessibilityLabel="要切换到的地图"
          items={choices()}
          value={map().length > 0 ? map() : undefined}
          placeholder={maps().length === 0 ? "这个玩法没列出地图，由服务器决定" : "选择地图"}
          size="small"
          disabled={maps().length === 0}
          onChange={(change) => setMap(change.value ?? "")}
        />
      </FormRow>
      <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>
        只影响这一次运行；要长期固定，用「设为启动模式」。
      </Text>
    </FormDialog>
  );
}

function Page(): SolidChild {
  const store = session();
  const [switching, setSwitching] = createSignal<ModeEntry | null>(null);
  const families = () => store.families();
  const modeCount = () => families().reduce((sum, family) => sum + family.modes.length, 0);
  const alive = () => store.instance()?.alive === true;

  return (
    <PageScroll style={{ gap: space.lg, padding: space.xl }}>
      <PageHeader
        title="模式与地图"
        icon="lucide:puzzle"
        description={`服务器自带的 ${modeCount()} 个玩法，按 ${families().length} 类分组。`}
        actions={
          <IconAction
            icon="lucide:refresh-cw"
            label="重新读一遍服务器版本里的玩法清单"
            onPress={() => store.refreshCatalog()}
          />
        }
      />

      <Note
        text={
          alive()
            ? "「设为启动模式」重启后生效；「立即切换」让正在跑的服务器马上换玩法，玩家会掉一次线。"
            : "「设为启动模式」重启后生效；服务器没在运行时不能立即切换。"
        }
      />

      {families().length === 0 ? (
        <EmptyHint
          icon="lucide:puzzle"
          title="没有读到玩法模式"
          description="服务器自带的清单里没有可识别的玩法（也可能还没在「服务器列表」选版本）；其余的要在「服务器配置」里手填。"
        />
      ) : (
        <View style={{ gap: space.lg }}>
          {families().map((family) => (
            <Card title={family.title} icon="lucide:layers" tone="accent" subtitle={`${family.modes.length} 个模式`}>
              <View style={{ gap: space.xs }}>
                {family.modes.map((mode) => (
                  <ModeRow mode={mode} onSwitch={setSwitching} />
                ))}
              </View>
            </Card>
          ))}
        </View>
      )}

      {families().length > 0 ? <MapBrowser /> : null}

      <Fold label="这些清单是从哪来的？">
        <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>
          {`玩法目录读自服务器版本的 platform/playlists_r5_patch.txt（带 r5f_mode_* 元数据的条目）；
地图清单是该玩法自己声明的那几行。新地图包要放进服务器目录并在玩法里登记才会出现在这里。`}
        </Text>
      </Fold>

      <SwitchDialog mode={switching()} onClose={() => setSwitching(null)} />
    </PageScroll>
  );
}
