import type { ProfileRow } from "@server/panel";
import { MANUAL_OPTION, SETTINGS_FIELDS, type FieldDef } from "@server/settings-fields";
/**
 * 服务器配置：左边是命名配置档案，右边是逐项启动设置。
 *
 * 版式约定（UI 重做后）：
 *  1. 设置列表是**只读清单**：一行 = 标签 + 当前值，点整行进弹窗改。
 *     过去每项常驻「说明 / 允许值 / 生效时机 / 编辑器 / 保存 / 恢复默认」六件套，
 *     14 项叠起来就是 14 块表单和 42 个按钮 —— 现在这些只出现在弹窗里。
 *  2. 档案的新建、覆盖、删除都是弹窗/确认框，行内只留 ⋯ 菜单。
 *  3. 右侧表单**必须**遍历 `@server/settings-fields` 的声明表渲染 —— 那份表是 CLI / 面板
 *     共用的唯一来源，页面手写字段清单会立刻与引擎参数漂移。
 *
 * 布局：GPUI 不是 CSS。页面根是列容器，两栏用 `flexDirection: "row"` +
 * 左侧固定 320 + 右侧 `flexGrow: 1`；滚动由 `PageScroll` 接管。
 */
import { Icon, Pressable, Text, View, type SolidChild } from "@solid-gpui/core";
import { Input, Select } from "@solid-gpui/core/components";
import { createEffect, createSignal } from "@solid-gpui/core/runtime";
import { createFileRoute } from "@solid-gpui/router";
import {
  Action,
  Card,
  Chip,
  Confirm,
  EmptyHint,
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

/**
 * 编辑一个设置项的弹窗：当前值、说明、允许值、生效时机、编辑器与「恢复默认」都在这里。
 *
 * 弹窗是同一个组件实例（`field` 从空变成某一项），所以换项时必须把草稿丢掉，
 * 否则第二项会带着第一项没保存的输入打开。
 */
function SettingDialog(props: { field: FieldDef | null; onClose: () => void }): SolidChild {
  const store = session();
  const [draft, setDraft] = createSignal<string | null>(null);
  const [manual, setManual] = createSignal(false);
  const [problem, setProblem] = createSignal<string | null>(null);

  createEffect<string | undefined, undefined>((previous) => {
    const id = props.field?.id;
    if (previous !== undefined && previous !== id) {
      setDraft(null);
      setManual(false);
      setProblem(null);
    }
    return id;
  }, undefined);

  /** 输入框里显示什么：用户改过就用草稿，否则用当前值。 */
  const text = (): string => draft() ?? (props.field ? props.field.editText(store.settings()) : "");

  const options = () =>
    props.field?.options ? props.field.options({ catalog: store.catalog(), settings: store.settings() }) : [];

  /** 选择项：key 去重（原生要求分组/条目 key 非空且唯一），空值换成哨兵 key。 */
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

  const editor = (): SolidChild => {
    const field = props.field;
    if (!field) return <View />;
    if (field.options !== undefined && !manual()) {
      // 当前值原样交给原生 `Select`，**不**因为"值不在清单里"就撤掉 `value`：清单是异步读来的、
      // 值还可能是手填的，两者对不上是常态。原生层把这种受控值保留为"未解析"（不选中、不显示）。
      return (
        <Select
          items={[{ key: field.id, items: items() }]}
          value={keyOfValue(text())}
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
        placeholder={field.spec}
        size="small"
        masked={field.kind === "password"}
        maskToggle={field.kind === "password"}
        onChange={(change) => setDraft(change.value)}
      />
    );
  };

  async function save(): Promise<void> {
    const field = props.field;
    if (!field) return;
    if (await store.saveSettings([{ id: field.id, raw: text() }])) props.onClose();
    else setProblem("这项没保存成功，看看底部的动作记录写了什么。");
  }

  const warning = () => {
    const message = props.field?.warn ? props.field.warn(store.settings()) : null;
    return message ? <Note tone="warning" text={message} /> : null;
  };

  return (
    <FormDialog
      open={props.field !== null}
      title={props.field?.label ?? ""}
      okText="保存"
      problem={problem()}
      width={520}
      onClose={props.onClose}
      onOk={() => void save()}
    >
      {props.field ? (
        <View style={{ flexDirection: "column", gap: space.md, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm, minWidth: 0 }}>
            <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>当前值</Text>
            <Text
              style={{
                width: 0,
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
          <FormRow label="改成">
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 0 }}>
              <View style={{ width: 0, flexGrow: 1, minWidth: 220 }}>{editor()}</View>
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
          </FormRow>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
              {`允许值：${props.field.spec}　|　${props.field.scope}`}
            </Text>
            <View style={{ flexGrow: 1, minWidth: 0 }} />
            <Action
              label="恢复默认"
              icon="lucide:refresh-cw"
              variant="ghost"
              compact
              tooltip={`默认值：${props.field.defaultText(store.settings())}`}
              onPress={() => {
                void store.resetSetting(props.field!.id);
                props.onClose();
              }}
            />
          </View>
          {warning()}
        </View>
      ) : null}
    </FormDialog>
  );
}

/** 一个设置项一行：标签 + 当前值，点整行进弹窗（悬停整行提亮，让人看得出可以点）。 */
function SettingRow(props: { field: FieldDef; onOpen: (field: FieldDef) => void }): SolidChild {
  const store = session();
  const [hover, setHover] = createSignal(false);
  return (
    <Pressable
      tooltip="点开修改"
      accessibilityRole="button"
      accessibilityLabel={`${props.field.label}：${props.field.display(store.settings())}`}
      onPress={() => props.onOpen(props.field)}
      onHoverChange={(value: boolean) => setHover(value)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingTop: space.sm,
        paddingBottom: space.sm,
        paddingLeft: space.sm,
        paddingRight: space.sm,
        borderRadius: radius.md,
        backgroundColor: hover() ? palette.panelHover : "#00000000",
        minWidth: 0,
      }}
    >
      <Text style={{ width: 132, flexShrink: 0, fontSize: fontSize.md, color: palette.text }}>{props.field.label}</Text>
      <Text
        style={{
          flexGrow: 1,
          minWidth: 0,
          fontSize: fontSize.md,
          color: palette.textMuted,
          fontFamily: font.mono,
        }}
      >
        {props.field.display(store.settings())}
      </Text>
      <Icon name="lucide:chevron-right" size={14} color={palette.textDim} />
    </Pressable>
  );
}

/** 档案一行：点主体即启用；覆盖 / 删除走 ⋯ 菜单 + 确认框。 */
function ProfileRow(props: {
  row: ProfileRow;
  onOverwrite: (name: string) => void;
  onDelete: (name: string) => void;
}): SolidChild {
  const store = session();
  const items = (): RowMenuItem[] => [
    {
      id: "activate",
      label: "启用这份档案",
      icon: "lucide:check",
      disabled: props.row.active,
      hint: props.row.active ? "已经在用这一份" : undefined,
    },
    { id: "overwrite", label: "用当前设置覆盖", icon: "lucide:download" },
    { id: "delete", label: "删除…", icon: "lucide:trash-2", tone: "danger" },
  ];
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
        accessibilityRole="button"
        accessibilityLabel={`启用配置档案 ${props.row.name}`}
        onPress={() => void store.activateProfile(props.row.name)}
        style={{ flexGrow: 1, minWidth: 0, flexDirection: "column", gap: 2 }}
      >
        <Text style={{ fontSize: fontSize.md, fontWeight: "semibold", color: palette.text }}>{props.row.name}</Text>
        <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
          {`${props.row.summary}　·　${formatRelative(props.row.updatedAt)}`}
        </Text>
      </Pressable>
      {props.row.active ? <Chip tone="success" label="已生效" icon="lucide:check" /> : null}
      <RowMenu
        label={`档案 ${props.row.name} 的操作`}
        items={items()}
        onSelect={(id) => {
          if (id === "activate") void store.activateProfile(props.row.name);
          if (id === "overwrite") props.onOverwrite(props.row.name);
          if (id === "delete") props.onDelete(props.row.name);
        }}
      />
    </View>
  );
}

function Page(): SolidChild {
  const store = session();
  const [editing, setEditing] = createSignal<FieldDef | null>(null);
  const [createOpen, setCreateOpen] = createSignal(false);
  const [draftName, setDraftName] = createSignal("");
  const [problem, setProblem] = createSignal<string | null>(null);
  const [overwriteTarget, setOverwriteTarget] = createSignal<string | null>(null);
  const [deleteTarget, setDeleteTarget] = createSignal<string | null>(null);

  const profiles = () => store.profiles();
  const currentName = () => profiles().find((row) => row.active)?.name ?? "—";

  async function createProfile(): Promise<void> {
    const name = draftName().trim();
    if (name.length === 0) {
      setProblem("先给档案起个名字。");
      return;
    }
    if (await store.writeProfile("create", name)) {
      setDraftName("");
      setProblem(null);
      setCreateOpen(false);
    } else {
      setProblem("新建失败，看看底部的动作记录写了什么。");
    }
  }

  return (
    <PageScroll style={{ gap: space.lg, padding: space.xl }}>
      <PageHeader
        title="服务器配置"
        icon="lucide:settings"
        description="启动设置与配置档案；这里填的值在启动时写回服务器，以面板为准。"
      />

      <View style={{ flexDirection: "row", gap: space.lg, minHeight: 0, minWidth: 0, alignItems: "flex-start" }}>
        <View style={{ width: 320, flexShrink: 0, minWidth: 0, gap: space.lg }}>
          <Card
            title="配置档案"
            icon="lucide:layers"
            tone="accent"
            subtitle={`${profiles().length} 个 · 已生效：${currentName()}`}
            actions={
              <IconAction
                icon="lucide:plus"
                label="新建档案（照抄当前设置）"
                onPress={() => {
                  setProblem(null);
                  setCreateOpen(true);
                }}
              />
            }
          >
            {profiles().length === 0 ? (
              <EmptyHint
                compact
                icon="lucide:layers"
                title="还没有配置档案"
                description="用右上角的 + 新建一份（照抄当前设置）。"
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
          </Card>

          <ProfileHint />
        </View>

        <View style={{ flexGrow: 1, minWidth: 0 }}>
          <Card
            title="启动设置"
            icon="lucide:sliders-horizontal"
            tone="info"
            subtitle="点任意一项改值；改完的表在下次启动时生效"
          >
            <View style={{ gap: 2 }}>
              {SETTINGS_FIELDS.map((field, index) => (
                <View style={{ gap: 2 }}>
                  {index > 0 ? <View style={{ height: 1, backgroundColor: palette.borderSoft }} /> : null}
                  <SettingRow field={field} onOpen={setEditing} />
                </View>
              ))}
            </View>
          </Card>
        </View>
      </View>

      <SettingDialog field={editing()} onClose={() => setEditing(null)} />

      <FormDialog
        open={createOpen()}
        title="新建配置档案"
        okText="新建"
        problem={problem()}
        onClose={() => setCreateOpen(false)}
        onOk={() => void createProfile()}
      >
        <FormRow label="档案名" help="新档案照抄当前设置；之后改设置不会自动同步到它，除非再点「用当前设置覆盖」。">
          <Input
            value={draftName()}
            placeholder="例如 1v1 夜间"
            ariaLabel="新档案名"
            cleanable
            onChange={(change) => setDraftName(change.value)}
          />
        </FormRow>
      </FormDialog>

      <Confirm
        open={overwriteTarget() !== null}
        title="覆盖这份档案？"
        message={`会把当前的设置写进「${overwriteTarget() ?? ""}」，这份档案旧的值就没了。`}
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
        danger
        title="删除这份档案？"
        message={`「${deleteTarget() ?? ""}」会被删掉。当前生效的设置不受影响。`}
        confirmLabel="删除"
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

/** 档案与设置的关系只有一句要记住的话，收在卡片下面，不占正文。 */
function ProfileHint(): SolidChild {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, minWidth: 0 }}>
      <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>点档案名即启用；右边改的是当前生效的值。</Text>
      <Help text="配置档案＝一套完整的启动设置快照。启动对话框默认选上次用的那份。" />
    </View>
  );
}
