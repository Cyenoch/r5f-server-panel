import * as api from "@server/panel";
import { SETTINGS_FIELDS } from "@server/settings-fields";
import { Text, View, type SolidChild } from "@solid-gpui/core";
import { Input, Select } from "@solid-gpui/core/components";
import { createSignal } from "@solid-gpui/core/runtime";
import { useNavigate } from "@solid-gpui/router";
import { session } from "../lib/session";
import { fontSize, palette, space } from "../lib/theme";
import {
  Action,
  Card,
  Chip,
  Confirm,
  EmptyHint,
  FormDialog,
  FormRow,
  KeyValueList,
  Note,
  PageHeader,
  PageScroll,
  RowMenu,
  Toolbar,
} from "./ui";

export function InstanceEditor(props: {
  instance: api.ServerInstance | null;
  open: boolean;
  onClose: () => void;
}): SolidChild {
  const store = session();
  const [name, setName] = createSignal(props.instance?.name ?? "");
  const [version, setVersion] = createSignal(props.instance?.version ?? store.versions()[0]?.name ?? "");
  const [template, setTemplate] = createSignal(props.instance?.templateId ?? "none");
  const [port, setPort] = createSignal(String(props.instance?.settings.port ?? api.nextFreePort(store.state())));
  const [hostname, setHostname] = createSignal(props.instance?.settings.hostname ?? "");
  const [visibility, setVisibility] = createSignal(String(props.instance?.settings.visibility ?? 0));
  const [problem, setProblem] = createSignal<string | null>(null);
  async function save(): Promise<void> {
    if (!name().trim()) {
      setProblem("请给实例起一个便于辨认的名称。");
      return;
    }
    if (!version()) {
      setProblem("请先安装并选择服务端版本。");
      return;
    }
    const settings = { ...(props.instance?.settings ?? api.defaultSettings) };
    const raw: Record<string, string> = {
      port: port(),
      hostname: hostname().trim() || name().trim(),
      visibility: visibility(),
    };
    for (const field of SETTINGS_FIELDS) {
      const value = raw[field.id];
      if (value === undefined) continue;
      const parsed = field.parse(value);
      if (!parsed.ok) {
        setProblem(parsed.error);
        return;
      }
      field.assign(settings, parsed.value);
    }
    const result = await store.run(props.instance ? "保存实例" : "创建实例", () => {
      const input = {
        name: name().trim(),
        version: version(),
        templateId: template() === "none" ? null : template(),
        settings,
      };
      return props.instance
        ? api.updateServerInstance(store.state(), props.instance.id, input)
        : api.createServerInstance(store.state(), input);
    });
    if (!result) {
      setProblem("未能保存，请查看底部动作记录中的具体原因。");
      return;
    }
    await store.refreshState();
    await store.refreshFast();
    store.refreshCatalog();
    store.notice(
      "success",
      props.instance ? "实例配置已保存" : "实例已创建",
      props.instance?.runtime ? "运行中的进程保持不变；网络与版本改动下次启动生效。" : result.name,
    );
    props.onClose();
  }
  return (
    <FormDialog
      open={props.open}
      title={props.instance ? "编辑实例" : "创建服务器实例"}
      okText={props.instance ? "保存配置" : "创建实例"}
      width={580}
      busy={store.busy() !== null}
      problem={problem()}
      onClose={props.onClose}
      onOk={() => void save()}
    >
      <FormRow label="实例名称" help="只用于面板内区分实例。">
        <Input
          ariaLabel="实例名称"
          value={name()}
          placeholder="例如 上海 · 1v1 训练"
          onChange={(change) => setName(change.value)}
        />
      </FormRow>
      <FormRow label="服务端版本">
        <Select
          accessibilityLabel="实例服务端版本"
          value={version() || undefined}
          placeholder="选择已安装版本"
          items={[{ key: "versions", items: store.versions().map((item) => ({ key: item.name, label: item.name })) }]}
          onChange={(change) => setVersion(change.value ?? "")}
        />
      </FormRow>
      <FormRow label="游戏模式模板" help="共享玩法规则；修改模板不会自动打断正在进行的对局。">
        <Select
          accessibilityLabel="实例游戏模式模板"
          value={template()}
          items={[
            {
              key: "templates",
              items: [
                { key: "none", label: "不使用模板 · 保留实例玩法" },
                ...store.state().templates.map((item) => ({ key: item.id, label: item.name })),
              ],
            },
          ]}
          onChange={(change) => setTemplate(change.value ?? "none")}
        />
      </FormRow>
      <FormRow label="玩家看到的名称">
        <Input
          ariaLabel="玩家看到的名称"
          value={hostname()}
          placeholder="留空时使用实例名称"
          onChange={(change) => setHostname(change.value)}
        />
      </FormRow>
      <FormRow label="游戏端口">
        <Input ariaLabel="实例游戏端口" value={port()} onChange={(change) => setPort(change.value)} />
      </FormRow>
      <FormRow label="可见性">
        <Select
          accessibilityLabel="实例可见性"
          value={visibility()}
          items={[
            {
              key: "visibility",
              items: [
                { key: "0", label: "离线 · 不连接匹配服务" },
                { key: "1", label: "隐藏 · 凭令牌加入" },
                { key: "2", label: "公开 · 发布到服务器列表" },
              ],
            },
          ]}
          onChange={(change) => setVisibility(change.value ?? "0")}
        />
      </FormRow>
      {visibility() !== "0" ? (
        <Note text="联网实例还需要在「设置」中配置公网地址，并放行 Windows 防火墙与云安全组的 UDP 端口。" />
      ) : null}
      {props.instance?.runtime ? (
        <Note tone="warning" text="保存不会重启当前进程。版本、端口与启动设置在下次启动时生效。" />
      ) : null}
    </FormDialog>
  );
}

export function InstancesPage(props: { runningOnly?: boolean }): SolidChild {
  const store = session();
  const navigate = useNavigate();
  const [search, setSearch] = createSignal("");
  const [editor, setEditor] = createSignal<{ instance: api.ServerInstance | null } | null>(null);
  const [remove, setRemove] = createSignal<api.ServerInstance | null>(null);
  const metrics = (id: string) => store.fleet().find((row) => row.instance.id === id)?.metrics;
  const rows = () =>
    store
      .state()
      .instances.filter(
        (item) =>
          (!props.runningOnly || metrics(item.id)?.alive) &&
          `${item.name} ${item.settings.hostname} ${item.settings.port}`.toLowerCase().includes(search().toLowerCase()),
      );
  async function open(id: string): Promise<void> {
    await store.selectInstance(id);
    await navigate({ to: "/server/detail" });
  }
  async function copy(id: string): Promise<void> {
    const copied = await store.run("复制实例", () => api.copyServerInstance(store.state(), id));
    if (!copied) return;
    await store.refreshState();
    store.notice("success", "实例已复制", `${copied.name} · UDP ${copied.settings.port} · 未启动`);
  }
  return (
    <PageScroll style={{ gap: space.lg, padding: space.xl }}>
      <PageHeader
        title={props.runningOnly ? "运行中的实例" : "服务器实例"}
        icon="lucide:layers"
        description={
          props.runningOnly
            ? "只显示仍在运行的进程；点击实例进入独立工作区。"
            : "一个实例，一套独立配置。版本与玩法可以复用，运行状态互不混用。"
        }
        actions={
          <Action
            label="创建实例"
            icon="lucide:plus"
            tone="info"
            variant="solid"
            onPress={() => setEditor({ instance: null })}
          />
        }
      />
      <Toolbar>
        <View style={{ width: 340 }}>
          <Input
            ariaLabel="搜索实例"
            value={search()}
            placeholder="搜索名称或端口"
            cleanable
            onChange={(change) => setSearch(change.value)}
          />
        </View>
        <View style={{ flexGrow: 1 }} />
        <Chip label={`${rows().length} 个实例`} />
        <Action
          label="刷新"
          icon="lucide:refresh-cw"
          compact
          disabled={store.busy() !== null}
          onPress={() => {
            void store.refreshState();
            void store.refreshFast();
          }}
        />
      </Toolbar>
      {store.refreshError() ? (
        <Note tone="warning" text={`状态采集失败：${store.refreshError()}，列表可能不是最新状态。`} />
      ) : null}
      {store.versions().length === 0 ? (
        <Note
          tone="warning"
          text="尚未安装服务端。先下载一个版本，再创建可启动的实例。"
          action={
            <Action
              label="前往版本库"
              icon="lucide:download"
              compact
              onPress={() => void navigate({ to: "/server/list" })}
            />
          }
        />
      ) : null}
      {rows().length === 0 ? (
        <EmptyHint
          icon="lucide:layers"
          title={search() ? "没有匹配的实例" : props.runningOnly ? "当前没有运行实例" : "创建你的第一个实例"}
          description={
            props.runningOnly
              ? "已停止实例仍保留在「服务器实例」中，配置不会丢失。"
              : "选择版本、端口和玩法模板；更多网络与安全设置可在实例详情中调整。"
          }
        />
      ) : (
        rows().map((item) => (
          <Card
            title={item.name}
            subtitle={`${item.settings.hostname} · UDP ${item.settings.port}`}
            icon="lucide:cpu"
            actions={
              <Toolbar>
                <Chip
                  tone={metrics(item.id)?.alive ? "success" : "neutral"}
                  label={metrics(item.id)?.alive ? "运行中" : "已停止"}
                />
                <Action label="打开实例" icon="lucide:chevron-right" compact onPress={() => void open(item.id)} />
                <RowMenu
                  label={`${item.name} 的操作`}
                  items={[
                    { id: "edit", label: "编辑实例", icon: "lucide:settings" },
                    { id: "copy", label: "复制为新实例", icon: "lucide:copy" },
                    {
                      id: "delete",
                      label: "删除实例",
                      icon: "lucide:trash-2",
                      tone: "danger",
                      disabled: metrics(item.id)?.alive === true,
                    },
                  ]}
                  onSelect={(action) => {
                    if (action === "edit") setEditor({ instance: item });
                    if (action === "copy") void copy(item.id);
                    if (action === "delete") setRemove(item);
                  }}
                />
              </Toolbar>
            }
          >
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xl }}>
              <View style={{ width: 0, flexGrow: 1, minWidth: 260 }}>
                <KeyValueList
                  rows={[
                    { label: "启动版本", value: item.version ?? "未选择" },
                    {
                      label: "玩法模板",
                      value:
                        store.state().templates.find((template) => template.id === item.templateId)?.name ??
                        "实例自定义",
                    },
                    {
                      label: "可见性",
                      value: item.settings.visibility === 2 ? "公开" : item.settings.visibility === 1 ? "隐藏" : "离线",
                    },
                  ]}
                />
              </View>
              <View style={{ width: 0, flexGrow: 1, minWidth: 220 }}>
                <KeyValueList
                  rows={[
                    {
                      label: "当前玩家",
                      value: metrics(item.id)?.alive ? (metrics(item.id)?.metrics?.players ?? "未读取") : "—",
                    },
                    { label: "运行版本", value: metrics(item.id)?.alive ? metrics(item.id)!.version : "—" },
                    { label: "内存", value: metrics(item.id)?.alive ? `${metrics(item.id)!.workingSetMB} MB` : "—" },
                  ]}
                />
              </View>
            </View>
          </Card>
        ))
      )}
      <Text style={{ color: palette.textDim, fontSize: fontSize.xs }}>
        复制会分配新端口，不复制运行进程。删除仅移除停止的实例，不删除共享服务端版本。
      </Text>
      {editor() ? <InstanceEditor instance={editor()!.instance} open onClose={() => setEditor(null)} /> : null}
      <Confirm
        open={remove() !== null}
        title="删除实例？"
        message={`删除「${remove()?.name ?? ""}」的实例配置；共享版本与玩法模板保留。正在运行的实例不能删除。`}
        danger
        confirmLabel="删除实例"
        onCancel={() => setRemove(null)}
        onConfirm={() => {
          const target = remove();
          if (!target) return;
          void store.run("删除实例", async () => {
            api.deleteServerInstance(store.state(), target.id);
            setRemove(null);
            await store.refreshState();
            await store.refreshFast();
          });
        }}
      />
    </PageScroll>
  );
}
