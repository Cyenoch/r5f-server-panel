import type { ModeEntry } from "@server/catalog";
import type { FieldId } from "@server/settings-fields";
/**
 * 模式与地图：服务端自带的玩法目录（`playlists_r5_patch.txt` 里带 `r5f_mode_*` 元数据的模式）。
 *
 * 目录按家族分组（1v1 在最前，排序在 `@server/catalog` 里定），页面只做展示与两条动作：
 * 「设为启动模式」写设置（重启后生效）、「立即切换」走控制通道（只对跑着的实例有意义）。
 */
import { Text, View, type SolidChild } from "@solid-gpui/core";
import { Select } from "@solid-gpui/core/components";
import { createSignal } from "@solid-gpui/core/runtime";
import { createFileRoute } from "@solid-gpui/router";
import { Action, Card, Chip, EmptyHint, Note, PageHeader, PageScroll } from "../../components/ui";
import { session } from "../../lib/session";
import { font, fontSize, palette, radius, space } from "../../lib/theme";

export const Route = createFileRoute("/config/modes")({ component: Page });

/** 一个模式一行：当前启动模式 / 正在跑的模式都标出来，动作直接写设置或走控制通道。 */
function ModeRow(props: { mode: ModeEntry }): SolidChild {
  const store = session();
  const launching = () => store.settings().playlist === props.mode.id;
  const live = () => {
    const metrics = store.instance();
    return metrics?.alive === true && metrics.metrics?.playlist === props.mode.id;
  };

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
      mapFallback === null
        ? "重启服务器后生效"
        : `当前启动地图「${settings.map || "(空)"}」不在这个玩法的地图清单里，已一并改为「${mapFallback}」，同样是重启后生效`,
    );
  }

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
      <View style={{ flexGrow: 1, minWidth: 0, flexDirection: "column", gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <Text style={{ fontSize: fontSize.md, fontFamily: font.mono, color: palette.primary }}>{props.mode.id}</Text>
          <Text style={{ fontSize: fontSize.md, fontWeight: "semibold", color: palette.text }}>{props.mode.title}</Text>
          {launching() ? <Chip tone="info" label="启动模式" icon="lucide:play" /> : null}
          {live() ? <Chip tone="success" label="运行中" icon="lucide:check" /> : null}
        </View>
        <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>
          {props.mode.blurb.length > 0 ? props.mode.blurb : "（这个玩法没有写简介）"}
        </Text>
        <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
          {`地图 ${props.mode.maps.length} 张　|　默认地图 ${props.mode.map.length > 0 ? props.mode.map : "(未声明)"}　|　分类 ${props.mode.familyTitle}`}
        </Text>
      </View>
      <Action
        label="设为启动模式"
        icon="lucide:play"
        compact
        disabled={launching()}
        onPress={() => void setLaunchMode()}
      />
      <Action
        label="立即切换"
        icon="lucide:zap"
        tone="success"
        compact
        disabled={store.instance()?.alive !== true}
        tooltip={
          store.instance()?.alive === true
            ? "让正在跑的服务器立刻换模式（玩家会掉一次线）"
            : "服务器没在跑：先启动它，或改用「设为启动模式」"
        }
        onPress={() => void store.switchMode(props.mode.id, props.mode.maps[0])}
      />
    </View>
  );
}

/** 地图浏览器：按选中的模式列出它带的地图，逐张设为启动地图。 */
function MapBrowser(): SolidChild {
  const store = session();
  const [picked, setPicked] = createSignal<string | null>(null);

  const modes = () => store.families().flatMap((family) => family.modes);
  const current = () => {
    const list = modes();
    if (list.length === 0) return null;
    const wanted = picked() ?? store.settings().playlist;
    return list.find((mode) => mode.id === wanted) ?? list[0];
  };
  const maps = () => current()?.maps ?? [];

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
        .map((mode) => ({
          key: mode.id,
          label: `${mode.id} — ${mode.title}`,
          description: mode.blurb.length > 0 ? mode.blurb : undefined,
        })),
    }));
  };

  return (
    <Card
      title="地图清单"
      icon="lucide:layers"
      subtitle="按玩法模式看它自带哪些地图；选的只是「启动时载入哪张」，改完重启服务器生效"
    >
      <View style={{ minWidth: 280, maxWidth: 420 }}>
        <Select
          items={groups()}
          value={current()?.id}
          placeholder="选一个玩法"
          size="small"
          onChange={(change) => {
            if (change.value !== undefined && change.value !== null) setPicked(change.value);
          }}
        />
      </View>
      {maps().length === 0 ? (
        <EmptyHint
          compact
          icon="lucide:layers"
          title="这个玩法没有列出地图"
          description="服务器会按它自己的顺序换图。新地图包要放进服务器目录（paks、vpk、maps 任一处），还要在这个玩法的地图清单里登记才会出现在这里；想马上指定一张，去「服务器配置」手填地图名。"
        />
      ) : (
        <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
          {maps().map((stem) => (
            <View style={{ width: 240, flexShrink: 0 }}>
              <Card
                title={stem}
                icon="lucide:image"
                tone={store.settings().map === stem ? "success" : "neutral"}
                padding={space.md}
              >
                <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
                  {store.settings().map === stem ? "当前启动地图" : `来自玩法 ${current()?.id ?? ""}`}
                </Text>
                <Action
                  label="设为启动地图"
                  compact
                  disabled={store.settings().map === stem}
                  onPress={() => void store.saveSettings([{ id: "map", raw: stem }])}
                />
              </Card>
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}

function Page(): SolidChild {
  const store = session();
  const families = () => store.families();
  const modeCount = () => families().reduce((sum, family) => sum + family.modes.length, 0);

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
        title="模式与地图"
        icon="lucide:puzzle"
        description={`服务器自带的玩法模式：${modeCount()} 个，按 ${families().length} 类分组。`}
        actions={
          <Action
            label="重新读取"
            icon="lucide:refresh-cw"
            onPress={() => store.refreshCatalog()}
            tooltip="重新读一遍服务器版本里的玩法模式"
          />
        }
      />

      <Note text="「设为启动模式 / 设为启动地图」只改本机设置，重启服务器（或换图）后生效；「立即切换」让正在跑的服务器马上换模式，玩家会掉一次线。" />

      {families().length === 0 ? (
        <EmptyHint
          icon="lucide:puzzle"
          title="没有读到玩法模式"
          description="服务器自带的玩法清单里没有可识别的玩法模式（也可能还没在「服务器列表」里选版本）。这里只列服务器声明过的玩法，其余的要在「服务器配置」里手填。"
        />
      ) : (
        <View style={{ gap: space.lg }}>
          {families().map((family) => (
            <Card
              title={family.title}
              icon="lucide:layers"
              tone="accent"
              subtitle={`${family.modes.length} 个玩法模式`}
            >
              <View style={{ gap: space.sm }}>
                {family.modes.map((mode) => (
                  <ModeRow mode={mode} />
                ))}
              </View>
            </Card>
          ))}
        </View>
      )}

      {families().length > 0 ? <MapBrowser /> : null}
    </PageScroll>
  );
}
