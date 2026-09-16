/**
 * 游戏模式模板：把「玩法 + 地图 + 对局参数」存成可复用的预设。
 *
 * 同一套玩法要开好几个实例时（不同地图、不同节奏），过去只能在每个实例里重填一遍设置；
 * 模板是本机的命名预设，实例引用模板 id，改模板就跟着改。
 *
 * 页面上必须一眼看懂的三件事（都是引擎事实，不是文案选择）：
 *  1. **模板只存在本机**：跟面板的设置文件一起，不写进任何版本目录、不动引擎 cfg；
 *  2. **只有"应用"才会生效**：参数以运行时覆盖下发（引擎原文 `playlist_override_set <var> <value>`，
 *     "Overrides a playlist var for every connected client"），活在实例进程里，重启后要重新应用；
 *  3. **编辑模板不会热重载正在跑的对局**：改完的模板要等下次启动或显式应用才用得上。
 *
 * 参数清单不在这里手写：玩法 → 字段全部来自 `@server/mode-templates`（那份表指着读取它的脚本行），
 * 所以不会出现"面板给了一个引擎不读的旋钮"。玩法/地图清单来自**参考版本**的目录
 * （`platform/playlists_r5_patch.txt`），参考版本只是为了照着填，不写进模板。
 */
import type { Catalog } from "@server/catalog";
import { loadCatalog } from "@server/catalog";
import type { ModeTemplate, TemplateField } from "@server/mode-templates";
import { templateFields, validateTemplate } from "@server/mode-templates";
import * as api from "@server/panel";
import { MANUAL_OPTION } from "@server/settings-fields";
import { Text, View, type SolidChild } from "@solid-gpui/core";
import { Input, Select, Switch, type Choice, type ChoiceGroup } from "@solid-gpui/core/components";
import { createEffect, createMemo, createSignal } from "@solid-gpui/core/runtime";
import {
  Action,
  Card,
  Chip,
  Confirm,
  EmptyHint,
  Fold,
  FormDialog,
  FormRow,
  Help,
  IconAction,
  KeyValue,
  Note,
  PageHeader,
  PageScroll,
  RowMenu,
  SectionTitle,
  StatusDot,
  type RowMenuItem,
  type Tone,
} from "../components/ui";
import { formatRelative } from "../lib/format";
import { session } from "../lib/session";
import { fontSize, palette, radius, space } from "../lib/theme";

/** 地图选择里的「不指定」哨兵：`Select` 的 key 不能为空。 */
const EMPTY_MAP = "__no_map__";

const EFFECT_LABEL: Record<TemplateField["effect"], string> = {
  "next-round": "下一局生效",
  changelevel: "换图后生效",
};

const EFFECT_HELP: Record<TemplateField["effect"], string> = {
  "next-round": "每局开始时脚本都会重新读这个值，所以改完下一局就能用上。",
  changelevel: "脚本只在换图（关卡初始化）时重新读这个值，所以运行中改了要等下一次换图。",
};

/** 一份模板在本机落地成什么样，一句话说清。 */
function TemplateCard(props: {
  template: ModeTemplate;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
}): SolidChild {
  const store = session();
  /** 用着这份模板的实例：模板是共享的，但实例各自跑各自的。 */
  const users = () => store.state().instances.filter((instance) => instance.templateId === props.template.id);
  /** 玩法名：问当前选中版本的目录，问不到就只显示 id（模板本身不绑版本）。 */
  const modeTitle = createMemo(
    () =>
      store
        .families()
        .flatMap((family) => family.modes)
        .find((mode) => mode.id === props.template.playlist)?.title ?? null,
  );

  /** 参数一行话：已覆盖的写用户值，没覆盖的标出玩法自己的值。 */
  const parameters = () => {
    const list = templateFields(props.template.playlist);
    if (list.length === 0) return "这个玩法没有面板能确认的对局参数";
    return list
      .map((field) => {
        const raw = props.template.overrides[field.key];
        const text = raw ?? field.defaultValue;
        const shown = field.kind === "boolean" ? (text === "1" ? "开" : "关") : text;
        return raw === undefined ? `${field.label} ${shown}（玩法默认）` : `${field.label} ${shown}`;
      })
      .join("　·　");
  };

  const items = (): RowMenuItem[] => [
    { id: "edit", label: "编辑…", icon: "lucide:settings" },
    { id: "copy", label: "复制一份", icon: "lucide:copy", hint: "照抄这份模板，换个新名字" },
    {
      id: "delete",
      label: "删除",
      icon: "lucide:trash-2",
      tone: "danger",
      disabled: users().length > 0,
      hint: users().length > 0 ? `${users().length} 个实例还在用它：先把那些实例改成别的模板` : "删掉这份本机预设",
    },
  ];

  return (
    <Card
      title={props.template.name}
      icon="lucide:layout"
      subtitle={`更新于 ${formatRelative(props.template.updatedAt)}`}
      actions={
        <RowMenu
          label={`${props.template.name} 的操作`}
          items={items()}
          onSelect={(id) => {
            if (id === "edit") props.onEdit();
            if (id === "copy") props.onCopy();
            if (id === "delete") props.onDelete();
          }}
        />
      }
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexWrap: "wrap" }}>
        <Chip tone="info" icon="lucide:puzzle" label={props.template.playlist} />
        {modeTitle() ? <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>{modeTitle()}</Text> : null}
        {users().length > 0 ? (
          <Chip tone="accent" icon="lucide:cpu" label={`${users().length} 个实例在用`} />
        ) : (
          <Chip tone="neutral" label="暂时没有实例在用" />
        )}
      </View>

      <View style={{ flexDirection: "column", gap: space.xs, minWidth: 0 }}>
        <KeyValue
          label="地图"
          value={props.template.map.length > 0 ? props.template.map : "（由玩法自己的清单决定）"}
          mono={props.template.map.length > 0}
        />
        <KeyValue label="对局参数" value={parameters()} />
      </View>

      {users().length > 0 ? (
        <View style={{ flexDirection: "column", gap: space.xs, minWidth: 0 }}>
          <SectionTitle text={`用着这个模板的实例（${users().length}）`} icon="lucide:cpu" />
          {users().map((instance) => {
            const metrics = store.fleet().find((row) => row.instance.id === instance.id)?.metrics ?? null;
            const alive = metrics?.alive === true;
            // 「已应用」只看进程自己的启动快照：`applied` 是启动那一刻写下的，
            // 之后改模板不会动它 —— 修订号不一致就是"还没重新应用"。
            const applied = instance.runtime?.applied ?? null;
            const confirmed = instance.runtime?.overrides?.length ?? 0;
            let tone: Tone = "neutral";
            let state =
              instance.runtime === null ? "没启动过：启动时会带上这份模板" : "上次启动没记下模板（可能是命令行启的）";
            if (applied !== null && applied.templateId !== props.template.id) {
              tone = "warning";
              state = "上次启动用的不是这份模板";
            } else if (applied !== null && applied.templateRevision !== props.template.updatedAt) {
              tone = "warning";
              state = "模板改过了：重启或重新应用才会用上新参数";
            } else if (applied !== null) {
              tone = "success";
              state = "上次启动带着这份模板（修订一致）";
            }
            const live = confirmed > 0 ? `　运行期已确认覆盖 ${confirmed} 项` : "";
            return (
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 0 }}>
                <StatusDot tone={tone} label={instance.name} />
                <Text style={{ fontSize: fontSize.sm, color: palette.textDim, flexGrow: 1, minWidth: 0 }}>
                  {`${alive ? "运行中" : "未运行"}　${state}${alive ? live : ""}`}
                </Text>
              </View>
            );
          })}
          <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
            修改模板不会自动影响当前对局；下次启动会加载已保存的模板，运行中应用需在实例详情确认。
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

/** 一个参数一行：左边名字 + 说明，右边开关/数字，最右是把覆盖去掉。 */
function FieldRow(props: {
  field: TemplateField;
  value: string | undefined;
  onChange: (raw: string) => void;
}): SolidChild {
  const overridden = () => props.value !== undefined;
  const shown = () => props.value ?? props.field.defaultValue;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingLeft: space.sm,
        paddingRight: space.sm,
        paddingTop: space.xs,
        paddingBottom: space.xs,
        borderRadius: radius.md,
        backgroundColor: overridden() ? palette.panelRaised : "#00000000",
        minWidth: 0,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexGrow: 1, minWidth: 0 }}>
        <Text style={{ fontSize: fontSize.md, color: palette.text }}>{props.field.label}</Text>
        <Help text={`${props.field.description} ${EFFECT_HELP[props.field.effect]}`} />
        <Text style={{ fontSize: fontSize.xs, color: overridden() ? palette.accent : palette.textDim }}>
          {overridden() ? "已覆盖" : `跟随玩法（${props.field.defaultValue}）`}
        </Text>
      </View>
      {props.field.kind === "boolean" ? (
        <Switch
          checked={shown() === "1"}
          accessibilityLabel={props.field.label}
          onChange={(next) => props.onChange(next ? "1" : "0")}
        />
      ) : (
        <View style={{ flexDirection: "row", width: 92 }}>
          <Input
            value={shown()}
            size="small"
            ariaLabel={props.field.label}
            placeholder={props.field.defaultValue}
            onChange={(change) => props.onChange(change.value)}
          />
        </View>
      )}
      <IconAction
        icon="lucide:x"
        label={overridden() ? "改回跟随玩法自己的值" : "当前就是玩法自己的值"}
        disabled={!overridden()}
        onPress={() => props.onChange("")}
      />
    </View>
  );
}

/** 新建 / 编辑模板的弹窗。草稿由页面持有，这里只负责编辑与保存。 */
function TemplateDialog(props: { draft: ModeTemplate | null; onClose: () => void }): SolidChild {
  const store = session();
  const [name, setName] = createSignal("");
  const [playlist, setPlaylist] = createSignal("");
  const [map, setMap] = createSignal("");
  const [overrides, setOverrides] = createSignal<Record<string, string>>({});
  const [version, setVersion] = createSignal("");
  const [manualMode, setManualMode] = createSignal(false);
  const [manualMap, setManualMap] = createSignal(false);
  const [problem, setProblem] = createSignal<string | null>(null);

  const versions = () => store.versions();
  /** 参考版本：只为照着它的目录填玩法/地图，**不**写进模板。 */
  const catalog = createMemo<Catalog>(() =>
    loadCatalog(versions().find((info) => info.name === version())?.path ?? null),
  );
  const modes = createMemo(() => catalog().modes.flatMap((family) => family.modes));
  const fields = () => templateFields(playlist().trim());

  /** 打开一份草稿时重建本地状态；新建（玩法为空）时按目录里的第一条给个起点。 */
  function hydrate(): void {
    const draft = props.draft;
    if (!draft) return;
    const installed = store.versions();
    const selectedVersion = api.selectedInstance(store.state())?.version ?? null;
    const preferred = installed.some((info) => info.name === selectedVersion)
      ? selectedVersion
      : (installed[0]?.name ?? "");
    const preview = loadCatalog(installed.find((info) => info.name === preferred)?.path ?? null);
    const seed =
      draft.playlist.length === 0 && draft.map.length === 0
        ? (preview.modes.flatMap((family) => family.modes)[0] ?? null)
        : null;
    setVersion(preferred ?? "");
    setName(draft.name);
    setPlaylist(seed?.id ?? draft.playlist);
    setMap(seed ? seed.map : draft.map);
    setOverrides({ ...draft.overrides });
    setManualMode(false);
    setManualMap(false);
    setProblem(null);
  }

  createEffect<string | null, string | null | undefined>((previous) => {
    const id = props.draft?.id ?? null;
    if (previous !== id) hydrate();
    return id;
  }, undefined);

  const currentMode = () => modes().find((mode) => mode.id === playlist().trim()) ?? null;
  /** 模式自己声明的地图；没声明时退回版本里的地图清单。 */
  const mapList = (): string[] => {
    const mode = currentMode();
    if (mode && mode.maps.length > 0) return mode.maps;
    return catalog().maps.map((entry) => entry.stem);
  };

  /** 换玩法时把地图收敛过去：新玩法没有这张图就清掉，让用户重选。 */
  function chooseMode(id: string): void {
    if (id === MANUAL_OPTION) {
      setManualMode(true);
      return;
    }
    const next = modes().find((mode) => mode.id === id) ?? null;
    setPlaylist(id);
    if (map().length > 0 && next !== null && next.maps.length > 0 && !next.maps.includes(map())) setMap("");
    setProblem(null);
  }

  const modeGroups = (): ChoiceGroup[] => {
    const groups: ChoiceGroup[] = [];
    const seen = new Set<string>();
    for (const family of catalog().modes) {
      const items: Choice[] = [];
      for (const mode of family.modes) {
        if (seen.has(mode.id)) continue;
        seen.add(mode.id);
        items.push({
          key: mode.id,
          label: `${mode.id} — ${mode.title}`,
          description: mode.blurb.length > 0 ? mode.blurb : `${mode.maps.length} 张地图`,
        });
      }
      if (items.length > 0)
        groups.push({ key: `family-${groups.length}`, label: `${family.title}（${items.length}）`, items });
    }
    if (playlist().trim().length > 0 && !seen.has(playlist().trim())) {
      groups.push({
        key: "current",
        label: "不在这个版本的清单里",
        items: [{ key: playlist().trim(), label: playlist().trim(), description: "手填的，或来自别的版本" }],
      });
    }
    groups.push({ key: "manual", items: [{ key: MANUAL_OPTION, label: "（手动输入…）" }] });
    return groups;
  };

  const mapGroups = (): ChoiceGroup[] => {
    const list = mapList();
    const labels = catalog().maps;
    const items: Choice[] = [
      { key: EMPTY_MAP, label: "（由玩法决定）", description: "模板不带地图，启动时用玩法自己的清单" },
      ...list.map((stem) => ({
        key: stem,
        label: stem,
        description: labels.find((entry) => entry.stem === stem)?.label,
      })),
    ];
    const current = map().trim();
    if (current.length > 0 && !list.includes(current)) {
      items.push({ key: current, label: current, description: "不在这个玩法的地图清单里" });
    }
    items.push({ key: MANUAL_OPTION, label: "（手动输入…）" });
    const mode = currentMode();
    return [{ key: "maps", label: mode ? `${mode.title} 的地图` : "版本里的地图", items }];
  };

  const setField = (key: string, raw: string): void => {
    setOverrides((current) => {
      const next = { ...current };
      if (raw.length === 0) delete next[key];
      else next[key] = raw;
      return next;
    });
    setProblem(null);
  };

  /** 当前玩法用不上的覆盖（换过玩法、手改过文件都会出现）——保存前必须清掉。 */
  const staleKeys = (): string[] =>
    Object.keys(overrides()).filter((key) => !fields().some((field) => field.key === key));

  const groups = () =>
    [
      {
        key: "next-round",
        effect: "next-round" as const,
        fields: fields().filter((field) => field.effect === "next-round"),
      },
      {
        key: "changelevel",
        effect: "changelevel" as const,
        fields: fields().filter((field) => field.effect === "changelevel"),
      },
    ].filter((group) => group.fields.length > 0);

  async function submit(): Promise<void> {
    const draft = props.draft;
    if (!draft) return;
    const next: ModeTemplate = {
      id: draft.id,
      name: name().trim(),
      playlist: playlist().trim(),
      map: map().trim(),
      overrides: { ...overrides() },
      updatedAt: new Date().toISOString(),
    };
    const clash = store.state().templates.find((other) => other.id !== next.id && other.name === next.name);
    const problems = validateTemplate(next);
    if (clash) problems.unshift(`已经有叫「${next.name}」的模板了`);
    if (problems.length > 0) {
      setProblem(problems.join("；"));
      return;
    }
    const saved = await store.run("保存模板", () => {
      api.saveModeTemplate(store.state(), next);
      return true;
    });
    if (saved === undefined) {
      setProblem("没保存成功，底部的动作记录里有原因。");
      return;
    }
    await store.refreshState();
    store.notice(
      "success",
      "模板已保存",
      `${next.name} · ${next.playlist}${next.map.length > 0 ? ` · ${next.map}` : ""}`,
    );
    props.onClose();
  }

  return (
    <FormDialog
      open={props.draft !== null}
      title={props.draft && props.draft.name.length > 0 ? `编辑模板：${props.draft.name}` : "新建模板"}
      okText="保存模板"
      width={600}
      problem={problem()}
      busy={store.busy() === "保存模板"}
      onClose={props.onClose}
      onOk={() => void submit()}
    >
      <FormRow label="模板名" help="只在本机显示，例如「1v1 快节奏」「1v1 长局」。">
        <Input
          value={name()}
          size="small"
          ariaLabel="模板名"
          placeholder="例如 1v1 快节奏"
          onChange={(change) => {
            setName(change.value);
            setProblem(null);
          }}
        />
      </FormRow>

      <FormRow
        label="参考版本"
        help="照哪个版本的清单填玩法与地图（实例的版本列表里选）。它不会写进模板：模板只存玩法 id 与地图名。"
      >
        <Select
          accessibilityLabel="参考哪个版本的清单"
          items={[
            {
              key: "versions",
              items: versions().map((info) => ({
                key: info.name,
                label: info.name,
                description: info.build.length > 0 ? info.build : info.gameVersion,
              })),
            },
          ]}
          value={version().length > 0 ? version() : undefined}
          placeholder={versions().length === 0 ? "没读到已安装的版本" : "选一个版本"}
          size="small"
          disabled={versions().length === 0}
          onChange={(change) => {
            if (change.value !== undefined && change.value !== null) setVersion(change.value);
          }}
        />
      </FormRow>
      {versions().length === 0 ? (
        <Note tone="warning" text="没读到已安装的服务端版本，玩法与地图只能手填；装好版本后这里会列出它的清单。" />
      ) : null}

      <FormRow label="玩法（模式）" help="清单来自参考版本。参数只展示本面板已核实读取方式的项目。">
        {manualMode() || catalog().modes.length === 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 0 }}>
            <View style={{ flexDirection: "column", flexGrow: 1, minWidth: 0 }}>
              <Input
                value={playlist()}
                size="small"
                ariaLabel="玩法 id"
                placeholder="例如 fs_1v1"
                onChange={(change) => {
                  setPlaylist(change.value.trim());
                  setProblem(null);
                }}
              />
            </View>
            {catalog().modes.length > 0 ? (
              <Action label="从清单里选" icon="lucide:list" compact onPress={() => setManualMode(false)} />
            ) : null}
          </View>
        ) : (
          <Select
            accessibilityLabel="玩法"
            items={modeGroups()}
            value={playlist().trim().length > 0 ? playlist().trim() : undefined}
            placeholder="从当前版本的清单里选一个玩法"
            size="small"
            searchable
            onChange={(change) => {
              if (change.value !== undefined && change.value !== null) chooseMode(change.value);
            }}
          />
        )}
      </FormRow>
      {currentMode() ? (
        <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
          {`${currentMode()?.blurb.length ? `${currentMode()?.blurb} · ` : ""}${currentMode()?.maps.length ?? 0} 张地图`}
        </Text>
      ) : null}

      <FormRow label="地图" help="启动时载入的地图。选了玩法后清单会收敛到该玩法带的地图。">
        {manualMap() ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 0 }}>
            <View style={{ flexDirection: "column", flexGrow: 1, minWidth: 0 }}>
              <Input
                value={map()}
                size="small"
                ariaLabel="地图名"
                placeholder="例如 mp_rr_arena_habitat"
                onChange={(change) => {
                  setMap(change.value.trim());
                  setProblem(null);
                }}
              />
            </View>
            <Action label="从清单里选" icon="lucide:list" compact onPress={() => setManualMap(false)} />
          </View>
        ) : (
          <Select
            accessibilityLabel="地图"
            items={mapGroups()}
            value={map().trim().length > 0 ? map().trim() : EMPTY_MAP}
            placeholder="（由玩法决定）"
            size="small"
            searchable
            onChange={(change) => {
              const key = change.value;
              if (key === undefined || key === null) return;
              if (key === MANUAL_OPTION) {
                setManualMap(true);
                return;
              }
              setMap(key === EMPTY_MAP ? "" : key);
              setProblem(null);
            }}
          />
        )}
      </FormRow>

      <SectionTitle text="对局参数" icon="lucide:sliders-horizontal" />
      {fields().length === 0 ? (
        <Note tone="info" text="此玩法尚无已核实的可编辑参数；模板仍可保存玩法与地图，不显示未经确认的开关。" />
      ) : (
        <View style={{ flexDirection: "column", gap: space.md, minWidth: 0 }}>
          {groups().map((group) => (
            <View style={{ flexDirection: "column", gap: space.xs, minWidth: 0 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>{EFFECT_LABEL[group.effect]}</Text>
                <Help text={EFFECT_HELP[group.effect]} />
              </View>
              {group.fields.map((field) => (
                <FieldRow field={field} value={overrides()[field.key]} onChange={(raw) => setField(field.key, raw)} />
              ))}
            </View>
          ))}
        </View>
      )}
      {staleKeys().length > 0 ? (
        <Note
          tone="warning"
          text={`这份模板里有 ${staleKeys().length} 个当前玩法用不上的参数：${staleKeys().join("、")}。保存前要清掉（换玩法时它们会留在草稿里）。`}
          action={
            <Action
              label="清掉它们"
              icon="lucide:trash-2"
              compact
              tone="warning"
              onPress={() => {
                setOverrides((current) => {
                  const next = { ...current };
                  for (const key of staleKeys()) delete next[key];
                  return next;
                });
                setProblem(null);
              }}
            />
          }
        />
      ) : null}
      <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
        不覆盖的参数沿用该版本玩法默认值。实例每次启动都会加载绑定模板；保存模板不会自动修改运行中的对局。
      </Text>
    </FormDialog>
  );
}

/** 页面导出：外壳把它挂在「配置 → 游戏模式模板」这一项上。 */
export function TemplatesPage(): SolidChild {
  const store = session();
  const [editing, setEditing] = createSignal<ModeTemplate | null>(null);
  const [removing, setRemoving] = createSignal<ModeTemplate | null>(null);

  const templates = () => store.state().templates;

  function openCreate(): void {
    setEditing({
      id: crypto.randomUUID(),
      name: "",
      playlist: "",
      map: "",
      overrides: {},
      updatedAt: new Date().toISOString(),
    });
  }

  /** 复制 = 照抄一份新模板（新 id、新名字），不打开弹窗，省一次确认。 */
  async function copyTemplate(template: ModeTemplate): Promise<void> {
    const taken = new Set(templates().map((entry) => entry.name));
    let name = `${template.name} 副本`;
    for (let index = 2; taken.has(name); index += 1) name = `${template.name} 副本 ${index}`;
    const next: ModeTemplate = { ...template, id: crypto.randomUUID(), name, updatedAt: new Date().toISOString() };
    const saved = await store.run("复制模板", () => {
      api.saveModeTemplate(store.state(), next);
      return true;
    });
    if (saved === undefined) return;
    await store.refreshState();
    store.notice("success", "已复制模板", `${name} — 改它不会影响原来的模板`);
  }

  async function deleteConfirmed(): Promise<void> {
    const template = removing();
    setRemoving(null);
    if (!template) return;
    if (store.state().instances.some((instance) => instance.templateId === template.id)) {
      store.notice("warning", "没有删除", `${template.name} 还有实例在用：先让那些实例改用别的模板`);
      return;
    }
    const removed = await store.run("删除模板", () => {
      api.deleteModeTemplate(store.state(), template.id);
      return true;
    });
    if (removed === undefined) return;
    await store.refreshState();
    store.notice("success", "已删除模板", template.name);
  }

  return (
    <PageScroll style={{ gap: space.lg, padding: space.xl }}>
      <PageHeader
        title="游戏模式模板"
        icon="lucide:layout"
        description={`本机保存的 ${templates().length} 套玩法预设：玩法 + 地图 + 对局参数，多个实例可以共用同一份。`}
        actions={
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <IconAction
              icon="lucide:refresh-cw"
              label="重新读一遍版本里的玩法清单"
              onPress={() => store.refreshCatalog()}
            />
            <Action label="新建模板" icon="lucide:plus" tone="info" variant="solid" onPress={openCreate} />
          </View>
        }
      />

      <Note text="模板决定实例启动时的玩法、地图与参数。保存不影响当前对局；运行中应用必须在实例详情中明确操作，并区分下轮读取和换图生效。" />

      {templates().length === 0 ? (
        <EmptyHint
          icon="lucide:layout"
          title="还没有模板"
          description="模板把「玩什么、哪张图、一局多久」存成一份，开第二个同类实例时直接选它，不用重填。"
          action={<Action label="新建第一个模板" icon="lucide:plus" tone="info" variant="solid" onPress={openCreate} />}
        />
      ) : (
        <View style={{ flexDirection: "column", gap: space.md, minWidth: 0 }}>
          {templates().map((template) => (
            <TemplateCard
              template={template}
              onEdit={() => setEditing({ ...template, overrides: { ...template.overrides } })}
              onCopy={() => void copyTemplate(template)}
              onDelete={() => setRemoving(template)}
            />
          ))}
        </View>
      )}

      <Fold label="这些参数是从哪来的？为什么别的玩法没有参数？">
        <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>
          {`参数清单跟着引擎脚本走：只有脚本真的用 GetCurrentPlaylistVar 读过的变量才会出现在这里。
本版确认被读的有三条 —— 单局时长（flowstateRoundtime）、换图前局数（flowstateRoundsBeforeChangeLevel）、自动换图（flowstateAutoChangeLevelEnable），
读它们的脚本是 1v1 家族的 sh_fs_1v1_helpers.gnut / sh_fs_1v1_bridge.gnut 与 Instagib 的 _gamemode_instagib.nut；
其他玩法暂未建立完整的参数读取证据，因此不展示未经核实的控制项。

"下一局生效" 与 "换图后生效" 也是照脚本标的：每局重新读的（局数上限、自动换图、Instagib 的时长）下一局就有效；
1v1 的单局时长在关卡初始化时读一次并缓存，所以运行中改它要等换图。

应用模板时每条覆盖下发一条引擎命令（playlist_override_set <变量> <值>），只发这个玩法认得的键；
玩法与地图换成别的、或重新载入地图，都是实例页上的显式动作，模板自己不会做。`}
        </Text>
      </Fold>

      <TemplateDialog draft={editing()} onClose={() => setEditing(null)} />

      <Confirm
        open={removing() !== null}
        title="删除模板"
        danger
        confirmLabel="删除"
        message={`删除本机模板「${removing()?.name ?? ""}」。仍被实例引用的模板不能删除，请先解除绑定。`}
        onConfirm={() => void deleteConfirmed()}
        onCancel={() => setRemoving(null)}
      />
    </PageScroll>
  );
}
