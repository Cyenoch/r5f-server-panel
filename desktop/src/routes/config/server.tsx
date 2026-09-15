import type { ProfileRow } from "@server/panel";
import { MANUAL_OPTION, SETTINGS_FIELDS, type FieldDef } from "@server/settings-fields";
/**
 * 服务器配置：左边是命名配置档案，右边是逐项启动设置。
 *
 * 右侧表单**必须**遍历 `@server/settings-fields` 的声明表渲染 —— 那份表是 CLI / 面板
 * 共用的唯一来源，页面手写字段清单会立刻与引擎参数漂移。
 *
 * 布局：GPUI 不是 CSS。页面根是列容器（`overflow: scroll` 让超出视口的长表单可滚，
 * 外壳的内容区不做滚动），两栏用 `flexDirection: "row"` + 左侧固定 320 + 右侧 `flexGrow: 1`。
 */
import { Pressable, Text, View, type SolidChild } from "@solid-gpui/core";
import { Input } from "@solid-gpui/core/components";
import { createEffect, createSignal } from "@solid-gpui/core/runtime";
import { createFileRoute } from "@solid-gpui/router";
import { Select } from "../../components/controls";
import { Action, Card, Chip, Confirm, EmptyHint, Note, PageHeader, PageScroll } from "../../components/ui";
import { formatRelative } from "../../lib/format";
import { session } from "../../lib/session";
import { font, fontSize, palette, radius, space } from "../../lib/theme";

export const Route = createFileRoute("/config/server")({ component: Page });

/** `Select` 的选择项 key 必须非空且全局唯一，而设置值允许是空串（"不指定地图"）——空值走这个哨兵 key。 */
const EMPTY_KEY = "__empty__";

/** 设置值 → 选择项 key（空值换成哨兵）。 */
function keyOfValue(value: string): string {
  return value.length === 0 ? EMPTY_KEY : value;
}

/** 一个设置项：当前值、说明、允许值/生效时机，加一个改值的编辑器。 */
function FieldRow(props: { field: FieldDef }): SolidChild {
  const store = session();
  const [draft, setDraft] = createSignal<string | null>(null);
  const [manual, setManual] = createSignal(false);

  /** 输入框里显示什么：用户改过就用草稿，否则用引擎设置里的当前值。 */
  const text = (): string => draft() ?? props.field.editText(store.settings());

  // 这一项的**已存值**变了（切档案、恢复默认、别处改的）就把草稿丢掉，输入框回到真实值；
  // 只是别的设置项被保存时不动草稿，免得顺手抹掉用户还没保存的输入。
  createEffect<string, string | undefined>((previous) => {
    const committed = props.field.editText(store.settings());
    if (previous !== undefined && previous !== committed) setDraft(null);
    return committed;
  }, undefined);

  const options = () =>
    props.field.options ? props.field.options({ catalog: store.catalog(), settings: store.settings() }) : [];

  /** 选择项：key 去重（模式/地图清单可能重复声明），空值换成哨兵 key。 */
  const items = (): { key: string; label: string; description: string | undefined }[] => {
    const seen = new Set<string>();
    const list: { key: string; label: string; description: string | undefined }[] = [];
    for (const option of options()) {
      const key = keyOfValue(option.value);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ key, label: option.label, description: option.note });
    }
    return list;
  };

  /** 当前值不在清单里（比如手填过自定义值）时不传 `value`，否则原生 Select 会拒绝渲染。 */
  const selectedKey = (): string | undefined => {
    const key = keyOfValue(text());
    return items().some((item) => item.key === key) ? key : undefined;
  };

  const warning = (): SolidChild => {
    const message = props.field.warn ? props.field.warn(store.settings()) : null;
    return message ? <Note tone="warning" text={message} /> : null;
  };

  const editor = (): SolidChild => {
    if (props.field.options !== undefined && !manual()) {
      return (
        <Select
          items={[{ key: props.field.id, items: items() }]}
          value={selectedKey()}
          placeholder="当前值不在清单里"
          size="small"
          onChange={(change) => {
            const key = change.value;
            if (key === undefined || key === null) return;
            const value = key === EMPTY_KEY ? "" : key;
            if (value === MANUAL_OPTION) {
              setManual(true);
              setDraft(text());
              return;
            }
            setDraft(value);
          }}
        />
      );
    }
    return (
      <Input
        value={text()}
        placeholder={props.field.spec}
        size="small"
        masked={props.field.kind === "password"}
        maskToggle={props.field.kind === "password"}
        onChange={(change) => setDraft(change.value)}
      />
    );
  };

  async function save(): Promise<void> {
    if (await store.saveSettings([{ id: props.field.id, raw: text() }])) setDraft(null);
  }

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: palette.borderSoft,
        borderRadius: radius.lg,
        padding: space.md,
        gap: space.sm,
        minWidth: 0,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm, minWidth: 0 }}>
        <Text style={{ fontSize: fontSize.lg, fontWeight: "semibold", color: palette.text }}>{props.field.label}</Text>
        <Text
          style={{
            flexGrow: 1,
            minWidth: 0,
            fontSize: fontSize.md,
            color: palette.primary,
            fontFamily: font.mono,
          }}
        >
          {props.field.display(store.settings())}
        </Text>
      </View>
      <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>{props.field.hint}</Text>
      <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
        {`允许值：${props.field.spec}　|　改了什么时候生效：${props.field.scope}`}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 0 }}>
        <View style={{ flexGrow: 1, minWidth: 220 }}>{editor()}</View>
        <Action
          label="保存"
          icon="lucide:check"
          tone="info"
          variant="solid"
          compact
          disabled={text() === props.field.editText(store.settings())}
          onPress={() => void save()}
        />
        <Action
          label="恢复默认"
          icon="lucide:refresh-cw"
          compact
          tooltip={`默认值：${props.field.defaultText(store.settings())}`}
          onPress={() => {
            setDraft(null);
            void store.resetSetting(props.field.id);
          }}
        />
        {props.field.options !== undefined && manual() ? (
          <Action
            label="用清单选择"
            icon="lucide:list"
            variant="ghost"
            compact
            onPress={() => {
              setManual(false);
              setDraft(null);
            }}
          />
        ) : null}
      </View>
      {warning()}
    </View>
  );
}

/** 档案一行：点主体即启用；覆盖 / 删除各自走确认框。 */
function ProfileRow(props: {
  row: ProfileRow;
  onOverwrite: (name: string) => void;
  onDelete: (name: string) => void;
}): SolidChild {
  const store = session();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        padding: space.sm,
        minWidth: 0,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: props.row.active ? palette.primary : palette.borderSoft,
        backgroundColor: props.row.active ? palette.panelRaised : "#00000000",
      }}
    >
      <Pressable
        tooltip="把这套设置设为当前生效"
        onPress={() => void store.activateProfile(props.row.name)}
        style={{ flexGrow: 1, minWidth: 0, flexDirection: "column", gap: 2 }}
      >
        <Text style={{ fontSize: fontSize.md, fontWeight: "semibold", color: palette.text }}>{props.row.name}</Text>
        <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>{props.row.summary}</Text>
        <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
          {`更新于 ${formatRelative(props.row.updatedAt)}`}
        </Text>
      </Pressable>
      {props.row.active ? <Chip tone="success" label="已生效" icon="lucide:check" /> : null}
      <Action
        label="覆盖"
        variant="ghost"
        compact
        tooltip="用当前设置覆盖这个档案"
        onPress={() => props.onOverwrite(props.row.name)}
      />
      <Action label="删除" tone="danger" variant="ghost" compact onPress={() => props.onDelete(props.row.name)} />
    </View>
  );
}

function Page(): SolidChild {
  const store = session();
  const [draftName, setDraftName] = createSignal("");
  const [overwriteTarget, setOverwriteTarget] = createSignal<string | null>(null);
  const [deleteTarget, setDeleteTarget] = createSignal<string | null>(null);

  const profiles = () => store.profiles();
  const currentName = () => profiles().find((row) => row.active)?.name ?? "—";
  const catalogLoading = () => store.catalog().modes.length === 0 && store.catalog().playlists.length === 0;

  async function createProfile(): Promise<void> {
    const name = draftName().trim();
    if (name.length === 0) return;
    if (await store.writeProfile("create", name)) setDraftName("");
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
        title="服务器配置"
        description="左边管配置档案——一套完整的启动设置，开服时选一套就行；右边是这套设置里每一项的值。"
        icon="lucide:settings"
      />

      <View style={{ flexDirection: "row", gap: space.lg, minHeight: 0, minWidth: 0, alignItems: "flex-start" }}>
        <View style={{ width: 320, flexShrink: 0, minWidth: 0, gap: space.lg }}>
          <Card
            title="配置档案"
            icon="lucide:layers"
            tone="accent"
            subtitle={`${profiles().length} 个 · 已生效：${currentName()}`}
          >
            {profiles().length === 0 ? (
              <EmptyHint
                compact
                icon="lucide:layers"
                title="还没有配置档案"
                description="在下面输入名字新建一份（会照抄当前设置）。"
              />
            ) : (
              <View style={{ gap: space.sm }}>
                {profiles().map((row) => (
                  <ProfileRow
                    row={row}
                    onOverwrite={(name) => setOverwriteTarget(name)}
                    onDelete={(name) => setDeleteTarget(name)}
                  />
                ))}
              </View>
            )}
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 0 }}>
              <View style={{ flexGrow: 1, minWidth: 0 }}>
                <Input
                  value={draftName()}
                  placeholder="新档案名"
                  size="small"
                  onChange={(change) => setDraftName(change.value)}
                />
              </View>
              <Action
                label="新建"
                icon="lucide:plus"
                compact
                disabled={draftName().trim().length === 0}
                onPress={() => void createProfile()}
              />
            </View>
            <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
              配置档案＝一套完整的启动设置，开服时选一套就行。点档案主体即启用（把档案里的值复制进当前设置）；“覆盖”把当前设置写回档案。
            </Text>
          </Card>
        </View>

        <View style={{ flexGrow: 1, minWidth: 0, gap: space.lg }}>
          <Card
            title="启动设置"
            icon="lucide:sliders-horizontal"
            subtitle={`${SETTINGS_FIELDS.length} 项 · 存在本机，不上传`}
          >
            <Note text="这里填的值优先：启动服务器时会把它们写进服务器配置文件，同一个配置项以面板为准；改完重启服务器生效。" />
            {catalogLoading() ? (
              <Note
                tone="info"
                text="还没读出玩法模式与地图清单：地图、模式两项眼下只有「(空)」和「手动输入…」可选，等清单出来再选更省事。"
              />
            ) : null}
            <View style={{ gap: space.md }}>
              {SETTINGS_FIELDS.map((field) => (
                <FieldRow field={field} />
              ))}
            </View>
          </Card>
        </View>
      </View>

      <Confirm
        open={overwriteTarget() !== null}
        title="覆盖配置档案"
        message={`用当前生效设置覆盖档案「${overwriteTarget() ?? ""}」？档案里原来的值会被替换。`}
        confirmLabel="覆盖"
        onConfirm={() => {
          const name = overwriteTarget();
          setOverwriteTarget(null);
          if (name !== null) void store.writeProfile("overwrite", name);
        }}
        onCancel={() => setOverwriteTarget(null)}
      />

      <Confirm
        open={deleteTarget() !== null}
        title="删除配置档案"
        message={`删除档案「${deleteTarget() ?? ""}」？只影响这套命名设置，不会动正在跑的服务器。`}
        confirmLabel="删除"
        danger
        onConfirm={() => {
          const name = deleteTarget();
          setDeleteTarget(null);
          if (name !== null) void store.writeProfile("delete", name);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </PageScroll>
  );
}
