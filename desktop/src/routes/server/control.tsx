/**
 * 控制面板：不改启动配置的**运行期**调整 —— 热切模式/地图、机器人、公告、重启与停止。
 *
 * 四张卡都在一个可换行的行里：窄窗口自动折行，每张卡不低于 `CARD_MIN_WIDTH`。
 * 需要控制通道（托管控制台）的动作统一按 `hosted()` 灰掉，页面顶部一条 Note 说明原因，
 * 免得点了没反应还不知道为什么。
 *
 * 根节点带 `overflow: "scroll"`：外壳的内容区（shell.tsx 的 `height: 0 + flexGrow: 1`）实测
 * 不是滚动容器，窗口默认 1280x820、可用高约 750px，四张卡竖起来会比它高，不滚动就点不到下面两张。
 */
import { Text, View, type SolidChild } from "@solid-gpui/core";
import { Input, Select } from "@solid-gpui/core/components";
import { createMemo, createSignal } from "@solid-gpui/core/runtime";
import { createFileRoute } from "@solid-gpui/router";
import { Action, Card, Chip, Confirm, Note, PageHeader, PageScroll } from "../../components/ui";
import { session } from "../../lib/session";
import { fontSize, palette, space } from "../../lib/theme";

export const Route = createFileRoute("/server/control")({ component: Page });

/** 卡片最小宽度：再窄就换行，不把内容压扁。 */
const CARD_MIN_WIDTH = 340;
/** 卡片的占位：撑满一行里分到的宽度，矮的时候不溢出。 */
const CELL_STYLE = { minWidth: CARD_MIN_WIDTH, flexGrow: 1, flexShrink: 1, minHeight: 0 };
const LABEL_STYLE = { fontSize: fontSize.sm, color: palette.textDim };

function Page(): SolidChild {
  const store = session();
  const [playlist, setPlaylist] = createSignal(store.settings().playlist);
  const [map, setMap] = createSignal(store.settings().map);
  const [botDraft, setBotDraft] = createSignal("1");
  const [pending, setPending] = createSignal<"bots" | "restart" | "stop" | null>(null);

  const instance = store.instance;
  const alive = () => instance()?.alive === true;
  const hosted = () => instance()?.hosted === true;
  const rotate = () => store.settings().announceRotate === "on";

  const modeChoices = createMemo(() =>
    store.families().map((family) => ({
      key: family.key,
      label: family.title,
      items: family.modes.map((mode) => ({
        key: mode.id,
        label: mode.id,
        description: `${mode.title} · ${mode.maps.length} 图`,
      })),
    })),
  );
  const selectedMode = createMemo(
    () =>
      store
        .families()
        .flatMap((family) => family.modes)
        .find((mode) => mode.id === playlist()) ?? null,
  );
  const mapChoices = createMemo(() => {
    const maps = selectedMode()?.maps ?? [];
    return maps.length === 0 ? [] : [{ key: "maps", items: maps.map((name) => ({ key: name, label: name })) }];
  });
  /** 运行期真正生效的模式/地图来自引擎回执；没有回执就如实说以启动配置为准。 */
  const liveLabel = createMemo(() => {
    const live = instance()?.live;
    return live ? `当前生效：${live.playlist} · ${live.map}` : "当前生效：服务器还没有回话 —— 先按启动配置显示。";
  });

  const pickMode = (id: string | null) => {
    if (id === null) return;
    setPlaylist(id);
    const mode = store
      .families()
      .flatMap((family) => family.modes)
      .find((entry) => entry.id === id);
    setMap(mode?.map || mode?.maps[0] || "");
  };

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
        title="控制面板"
        description="不用重启就能调整：换模式地图、加机器人、发公告，以及重启和停止。"
        icon="lucide:sliders-horizontal"
      />

      {hosted() ? null : (
        <Note
          tone="warning"
          text={
            alive()
              ? "面板没接上这台服务器 —— 没有面板控制通道，立即切换、机器人、公告都发不出去，只有重启和停止还能用；重启这台服务器让它由面板启动。"
              : "服务器没在运行 —— 先启动服务器，立即切换、机器人、公告才有作用。"
          }
        />
      )}

      <View style={{ flexDirection: "row", gap: space.lg, flexWrap: "wrap", minWidth: 0, minHeight: 0 }}>
        <View style={CELL_STYLE}>
          <Card title="模式与地图" subtitle="立即生效（不用重启）" icon="lucide:layers" tone="info">
            <View style={{ flexDirection: "column", gap: space.sm, minWidth: 0 }}>
              <Text style={LABEL_STYLE}>模式</Text>
              <Select
                items={modeChoices()}
                value={playlist().length > 0 ? playlist() : undefined}
                placeholder="选择模式"
                disabled={!hosted()}
                style={{ width: 260 }}
                slots={{
                  empty: <Text style={LABEL_STYLE}>还没读到可选的模式 —— 点 重新读目录 再试一次。</Text>,
                }}
                onChange={(change) => pickMode(change.value ?? null)}
              />
              <Text style={LABEL_STYLE}>地图</Text>
              <Select
                items={mapChoices()}
                value={map().length > 0 ? map() : undefined}
                placeholder="选择地图"
                disabled={!hosted() || mapChoices().length === 0}
                style={{ width: 260 }}
                slots={{
                  empty: <Text style={LABEL_STYLE}>这个模式没有可选地图 —— 切换时由服务器自己决定。</Text>,
                }}
                onChange={(change) => setMap(change.value ?? "")}
              />
              <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>{liveLabel()}</Text>
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <Action
                  label="立即切换"
                  icon="lucide:zap"
                  tone="info"
                  variant="solid"
                  disabled={!hosted() || playlist().length === 0}
                  onPress={() => void store.switchMode(playlist(), map().length > 0 ? map() : undefined)}
                />
                <Action label="重新读目录" icon="lucide:refresh-cw" onPress={() => store.refreshCatalog()} />
              </View>
              <Note text="这是立即生效的切换，不改启动配置；要长期固定，去 配置文件 → 服务器配置。" />
            </View>
          </Card>
        </View>

        <View style={CELL_STYLE}>
          <Card title="机器人" subtitle="填人数、试模式" icon="lucide:puzzle" tone="accent">
            <View style={{ flexDirection: "column", gap: space.sm, minWidth: 0 }}>
              <Text style={LABEL_STYLE}>数量</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <Input
                  value={botDraft()}
                  placeholder="1"
                  disabled={!hosted()}
                  style={{ width: 90 }}
                  onChange={(change) => setBotDraft(change.value)}
                />
                <Action
                  label="添加"
                  icon="lucide:plus"
                  disabled={!hosted()}
                  onPress={() => void store.addBots({ count: Number.parseInt(botDraft(), 10) || 1 })}
                />
                <Action
                  label="清空"
                  icon="lucide:minus"
                  tone="danger"
                  disabled={!hosted()}
                  onPress={() => setPending("bots")}
                />
              </View>
              <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>
                {hosted()
                  ? `当前机器人 ${store.players().filter((player) => player.uniqueid === "0").length} 个`
                  : "读不到机器人数量 —— 面板没接上这台服务器。"}
              </Text>
              <Note text="机器人不可封禁，只能踢。" />
            </View>
          </Card>
        </View>

        <View style={CELL_STYLE}>
          <Card title="公告" subtitle="轮播与进场欢迎" icon="lucide:bell" tone="warning">
            <View style={{ flexDirection: "column", gap: space.sm, minWidth: 0 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <Text style={LABEL_STYLE}>轮播</Text>
                <Chip
                  tone={rotate() ? "success" : "neutral"}
                  label={rotate() ? "开启（轮播 + 进场欢迎）" : "关闭（服务器默认，不发公告）"}
                />
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                <Action
                  label="开启"
                  icon="lucide:play"
                  onPress={() => void store.saveSettings([{ id: "announceRotate", raw: "on" }])}
                />
                <Action
                  label="关闭"
                  icon="lucide:pause"
                  onPress={() => void store.saveSettings([{ id: "announceRotate", raw: "default" }])}
                />
                <Action
                  label="立即广播"
                  icon="lucide:bell"
                  tone="info"
                  variant="solid"
                  disabled={!hosted()}
                  onPress={() => void store.broadcast()}
                />
              </View>
              <Note text="服务器对广播可能没有回应 —— 没回应不等于成功，要真人在线看到才算数。" />
            </View>
          </Card>
        </View>

        <View style={CELL_STYLE}>
          <Card
            title="危险操作"
            subtitle="这几个按钮会直接影响到正在玩的玩家"
            icon="lucide:triangle-alert"
            tone="danger"
          >
            <View style={{ flexDirection: "column", gap: space.sm, minWidth: 0 }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                <Action
                  label="重启服务器"
                  icon="lucide:refresh-cw"
                  disabled={!alive()}
                  onPress={() => setPending("restart")}
                />
                <Action
                  label="停止服务器"
                  icon="lucide:square"
                  tone="danger"
                  variant="solid"
                  disabled={!alive()}
                  onPress={() => setPending("stop")}
                />
              </View>
              <Note
                tone="warning"
                text={
                  alive()
                    ? "重启会让所有在线玩家掉线；停止后要手动再启动。"
                    : "还没有在运行的服务器 —— 先启动服务器，这两个按钮才有用。"
                }
              />
            </View>
          </Card>
        </View>
      </View>

      <Confirm
        open={pending() === "bots"}
        title="清空机器人？"
        message="把所有机器人移出当前对局，真人玩家不受影响。"
        confirmLabel="清空"
        danger
        onConfirm={() => {
          setPending(null);
          void store.clearBots();
        }}
        onCancel={() => setPending(null)}
      />
      <Confirm
        open={pending() === "restart"}
        title="重启服务器？"
        message="停止后按当前配置重新启动，所有在线玩家会掉线。"
        confirmLabel="重启"
        danger
        onConfirm={() => {
          setPending(null);
          void store.restartServer();
        }}
        onCancel={() => setPending(null)}
      />
      <Confirm
        open={pending() === "stop"}
        title="停止服务器？"
        message="立即结束服务器，所有在线玩家掉线，之后需要手动再启动。"
        confirmLabel="停止"
        danger
        onConfirm={() => {
          setPending(null);
          void store.stopServer();
        }}
        onCancel={() => setPending(null)}
      />
    </PageScroll>
  );
}
