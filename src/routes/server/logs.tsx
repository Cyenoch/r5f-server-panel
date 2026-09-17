/**
 * 实时日志：引擎输出 + 控制台命令。
 *
 * 布局要点（GPUI 不是 CSS）：日志区是页面里唯一吃掉剩余高度的一层，
 * 用外层 `height: 0 + flexGrow: 1` 包住，内层再 `flexGrow: 1 + overflow: "scroll"`；
 * 其余各层都显式写了 `flexDirection` / `minWidth: 0` / `minHeight: 0`。
 */
import { Text, TextInput, View, type SolidChild } from "@solid-gpui/core";
import { Select } from "@solid-gpui/core/components";
import { createMemo, createSignal } from "@solid-gpui/core/runtime";
import { createFileRoute } from "@solid-gpui/router";
import { Action, IconAction, Note, PageHeader, Toolbar } from "../../components/ui";
import { formatBytes, formatRelative } from "../../lib/format";
import { session, type NoticeKind } from "../../lib/session";
import { font, fontSize, logTone, palette, radius, space } from "../../lib/theme";

export const Route = createFileRoute("/server/logs")({ component: Page });

/** 渲染上限：日志可能有 5000 行，全量塞进视图会拖慢窗口。 */
const TAIL_LINES = 600;
/** 回执面板只留最近几条：它是「刚发出去的命令」，不是历史记录。 */
const RECEIPT_ROWS = 6;

/** 回执分类点的配色：与会话层的 notice 语义色同一套。 */
const RECEIPT_COLOR: Record<NoticeKind, string> = {
  info: palette.info,
  success: palette.success,
  warning: palette.warning,
  error: palette.danger,
};

function Page(): SolidChild {
  const store = session();
  const [draft, setDraft] = createSignal("");
  /** 暂停跟随那一刻的画面：会话层继续在后台读增量，解冻后立刻回到最新。 */
  const [frozen, setFrozen] = createSignal<string[]>([]);

  const instance = store.instance;
  const alive = () => instance()?.alive === true;
  const hosted = () => instance()?.hosted === true;

  const lines = createMemo(() => (store.following() ? store.logLines().slice(-TAIL_LINES) : frozen()));
  const receipts = createMemo(() => store.consoleLog().slice(0, RECEIPT_ROWS));
  const shardChoices = createMemo(() => {
    const items = store.shards().map((shard) => ({
      key: shard.path,
      label: shard.current
        ? `本次运行（${formatRelative(shard.mtime)}开始）`
        : `${formatRelative(shard.mtime)}那次运行`,
      description: formatBytes(shard.size),
    }));
    return items.length === 0 ? [] : [{ key: "runs", items }];
  });
  const errorBytes = () => store.health()?.error.bytes ?? 0;

  const toggleFollow = () => {
    const next = !store.following();
    if (!next) setFrozen(store.logLines().slice(-TAIL_LINES));
    store.setFollowing(next);
  };

  const submit = () => {
    void store.console(draft());
    setDraft("");
  };

  return (
    // 高度必须"确定"（height: 0 + flexGrow: 1）：否则页面按内容撑高，
    // 日志区一抢空间，底部的指令输入框就被顶到视口外面，用户够不到。
    <View
      style={{
        height: 0,
        flexGrow: 1,
        minHeight: 0,
        minWidth: 0,
        flexDirection: "column",
        gap: space.md,
        padding: space.xl,
      }}
    >
      <PageHeader
        title="实时日志"
        icon="lucide:list"
        description="服务器输出的内容；下面可以直接敲指令，回执跟着显示。"
      />

      <Toolbar>
        <Action
          label={store.following() ? "跟随中" : "已暂停"}
          icon={store.following() ? "lucide:pause" : "lucide:play"}
          tone={store.following() ? "info" : "neutral"}
          variant={store.following() ? "solid" : "outline"}
          onPress={toggleFollow}
          tooltip={store.following() ? "暂停刷新（画面停在当前）" : "继续跟随最新输出"}
        />
        <IconAction
          icon="lucide:trash-2"
          label="清屏（只清画面，不动日志文件）"
          onPress={() => {
            store.clearLog();
            setFrozen([]);
          }}
        />
        <IconAction icon="lucide:refresh-cw" label="立刻读一次新增内容" onPress={() => store.pollLog()} />
        <Select
          items={shardChoices()}
          value={store.logPath() ?? undefined}
          placeholder="历史日志"
          style={{ width: 300 }}
          slots={{
            empty: (
              <Text style={{ color: palette.textDim, fontSize: fontSize.sm }}>
                还没有历史日志 —— 服务器启动过一次之后就有
              </Text>
            ),
          }}
          onChange={(change) => store.openShard(change.value ?? null)}
        />
      </Toolbar>

      {/* 两边都可能没有日志文件：先判空再比，否则会误报“在看历史分片”。 */}
      {store.logPath() !== null && instance()?.logFile !== store.logPath() ? (
        <Note text="在看历史日志（不是这次运行）：上面的下拉里选回本次运行。" />
      ) : null}

      {errorBytes() > 0 ? (
        <Note
          tone="danger"
          text={`本次运行记录到了错误（${formatBytes(errorBytes())}），请打开上方「健康」标签查看。`}
        />
      ) : null}

      <View style={{ height: 0, flexGrow: 1, minHeight: 0, minWidth: 0, flexDirection: "column" }}>
        <View
          style={{
            flexGrow: 1,
            minHeight: 0,
            minWidth: 0,
            flexDirection: "column",
            backgroundColor: palette.log,
            borderRadius: radius.md,
            padding: space.md,
            gap: 1,
            overflow: "scroll",
          }}
        >
          {/* 只渲染尾部：`View` 没有暴露程序化滚动命令（那是 Scrollable/VirtualList 的
              `scrollTo`），所以不做「自动滚到底」，改为少渲染几行并把最新一行放在最后。 */}
          {lines().length === 0 ? (
            <Text style={{ color: palette.logDim, fontSize: fontSize.sm }}>
              服务器还没有输出 —— 启动后这里会实时刷新。
            </Text>
          ) : (
            lines().map((line) => (
              <Text style={{ fontFamily: font.mono, fontSize: fontSize.sm, color: logTone(line) }}>{line}</Text>
            ))
          )}
        </View>
      </View>

      <View style={{ flexDirection: "column", gap: space.sm, minWidth: 0, flexShrink: 0 }}>
        {receipts().length === 0 ? null : (
          <View style={{ flexDirection: "column", gap: space.xs, minWidth: 0 }}>
            {receipts().map((entry) => (
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm, minWidth: 0 }}>
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    marginTop: 5,
                    flexShrink: 0,
                    backgroundColor: RECEIPT_COLOR[entry.kind],
                  }}
                />
                <Text style={{ fontFamily: font.mono, fontSize: fontSize.sm, color: palette.text, flexShrink: 0 }}>
                  {entry.line}
                </Text>
                <Text style={{ fontSize: fontSize.sm, color: palette.textMuted, flexGrow: 1, minWidth: 0 }}>
                  {entry.text}
                </Text>
              </View>
            ))}
          </View>
        )}

        {hosted() ? null : (
          <Note
            tone="warning"
            text={
              alive()
                ? "面板没接上这台服务器，命令发不出去 —— 重启这台服务器让它由面板启动。"
                : "服务器没在运行 —— 启动后才能发送指令。"
            }
          />
        )}

        <TextInput
          value={draft()}
          placeholder="输入指令，回车发送"
          disabled={!hosted()}
          onChangeText={setDraft}
          onSubmitEditing={submit}
          accessibilityLabel="指令输入框"
          style={{
            // 高度要容得下「行高 20 + 上下内边距 8+8」，否则输入的文字会被裁掉下半截。
            height: 36,
            flexShrink: 0,
            padding: space.sm,
            borderWidth: 1,
            borderColor: palette.border,
            borderRadius: radius.md,
            backgroundColor: palette.panelRaised,
            color: palette.text,
            fontFamily: font.mono,
            fontSize: fontSize.sm,
          }}
        />
      </View>
    </View>
  );
}
