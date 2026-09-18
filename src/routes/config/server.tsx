/** Selected instance settings. Shared gameplay belongs to its mode template. */
import { Icon, Pressable, Text, View, type SolidChild } from "@solid-gpui/core";
import { Input, Select } from "@solid-gpui/core/components";
import { createEffect, createSignal } from "@solid-gpui/core/runtime";
import { createFileRoute } from "@solid-gpui/router";
import { MANUAL_OPTION, SETTINGS_FIELDS, type FieldDef } from "#server/settings-fields";
import { InstanceEditor } from "../../components/instances";
import { Action, Card, FormDialog, FormRow, Note, PageHeader, PageScroll } from "../../components/ui";
import { Fold } from "../../components/ui";
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
            {props.field.id === "hostip" ? (
              <Action
                label="获取当前公网 IP"
                icon="lucide:globe"
                variant="ghost"
                compact
                disabled={store.busy() !== null}
                tooltip={`问回显服务要本机公网 IPv4，写成 IP:${store.settings().port} 存进这一项`}
                onPress={() => {
                  void store.detectHostip();
                  props.onClose();
                }}
              />
            ) : null}
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

function Page(): SolidChild {
  const store = session();
  const [editing, setEditing] = createSignal<FieldDef | null>(null);
  const [identityOpen, setIdentityOpen] = createSignal(false);
  const basic = new Set(["hostname", "hostip", "port", "visibility", "password", "authMode"]);
  const gameplay = new Set(["map", "playlist"]);
  const rows = (fields: FieldDef[]) => fields.map((field) => <SettingRow field={field} onOpen={setEditing} />);
  return (
    <PageScroll style={{ gap: space.lg, padding: space.xl }}>
      <PageHeader
        title="实例设置"
        icon="lucide:settings"
        description="此处显示已保存的启动配置，不代表当前进程已经采用。"
        actions={<Action label="版本与模板" icon="lucide:layers" onPress={() => setIdentityOpen(true)} />}
      />
      {store.running() ? (
        <Note
          tone="warning"
          text="保存不会中断对局。网络、版本和启动参数在下次启动时生效；玩法模板通过上方「应用玩法」单独处理。"
        />
      ) : null}
      <Card title="名称、网络与访问" icon="lucide:globe">
        {rows(SETTINGS_FIELDS.filter((field) => basic.has(field.id)))}
      </Card>
      {store.selected()?.templateId ? (
        <Note
          text={`玩法由模板「${store.state().templates.find((item) => item.id === store.selected()?.templateId)?.name ?? "未知模板"}」管理，地图与规则请在游戏模式模板中编辑。`}
        />
      ) : (
        <Card title="自定义玩法" icon="lucide:puzzle">
          {rows(SETTINGS_FIELDS.filter((field) => gameplay.has(field.id)))}
        </Card>
      )}
      <Fold label="高级设置 · 限流、日志与启动参数" icon="lucide:sliders-horizontal">
        <Card>{rows(SETTINGS_FIELDS.filter((field) => !basic.has(field.id) && !gameplay.has(field.id)))}</Card>
      </Fold>
      <SettingDialog field={editing()} onClose={() => setEditing(null)} />
      {identityOpen() && store.selected() ? (
        <InstanceEditor open instance={store.selected()} onClose={() => setIdentityOpen(false)} />
      ) : null}
    </PageScroll>
  );
}
