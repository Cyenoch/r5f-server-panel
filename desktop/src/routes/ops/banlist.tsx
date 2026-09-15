/**
 * 封禁名单：两样东西各说各话。
 *
 *  1. **本机台账**（`moderation.json`）：时长、原因、到期只有这里有 —— 引擎的 `ban` 只有一个参数，
 *     封了就是永久，本工具的"临时封禁"是靠这条记录 + 日志守护代发解封兑现的。
 *  2. **引擎名单**（`banlist.json`）：结构由引擎（Spire 侧）决定，这里原样打印。
 *
 * 能确认的只有文件里写了什么：引擎对 `ban` / `banlist_reload` **静默**，静默不是成功。
 */
import { Text, View, type SolidChild } from "@solid-gpui/core";
import { Scrollable, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@solid-gpui/core/components";
import { createEffect, createMemo, createSignal } from "@solid-gpui/core/runtime";
import { createFileRoute } from "@solid-gpui/router";
import { Action, Card, EmptyHint, KeyValueList, Note, PageHeader, toneColor, type Tone } from "../../components/ui";
import { formatDateTime, formatRelative } from "../../lib/format";
import { session } from "../../lib/session";
import { font, fontSize, palette, radius, space } from "../../lib/theme";

export const Route = createFileRoute("/ops/banlist")({ component: Page });

/** 引擎回执的四类（`receipt.ts` 的判定）；`silent` 是"命令存在但一个字都不回"，不是成功。 */
type ReceiptKind = "success" | "unknown" | "usage" | "silent";

/** `banlist_reload` 的回执：实测静默，所以界面只能转述引擎说了什么（或没说）。 */
type ReloadReceipt = { kind: ReceiptKind; detail: string };

/** 引擎名单：文件路径 + 原样 JSON（面板不解析结构，只做存在性与 JSON 合法性）。 */
type EngineBanlist = { file: string | null; data: unknown; reload: ReloadReceipt | null };

const RECEIPT_LABEL: Record<ReceiptKind, string> = {
  success: "服务器确认执行",
  unknown: "服务器不认识这条指令",
  usage: "指令的写法不对",
  silent: "指令已发出（服务器没有回话）",
};

const RECEIPT_TONE: Record<ReceiptKind, Tone> = {
  success: "success",
  unknown: "danger",
  usage: "danger",
  silent: "warning",
};

/** 名单重新加载的结果：服务器回了几类话就写几类话 —— 没有回话不是成功。 */
function ReceiptNote(props: { receipt: ReloadReceipt }): SolidChild {
  const suffix =
    props.receipt.kind === "silent"
      ? "（没有回话不等于名单已经重新加载，以名单内容为准）"
      : props.receipt.detail
        ? ` —— ${props.receipt.detail}`
        : "";
  return (
    <Note
      tone={RECEIPT_TONE[props.receipt.kind]}
      text={`重新加载名单：${RECEIPT_LABEL[props.receipt.kind]}${suffix}`}
    />
  );
}

/** 表头格：列宽由 width / grow 决定，样式统一。 */
function HeadCell(props: { label: string; width?: number; grow?: boolean }): SolidChild {
  return (
    <TableHead style={{ width: props.width, flexGrow: props.grow ? 1 : undefined, flexShrink: 0 }}>
      <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>{props.label}</Text>
    </TableHead>
  );
}

/** 数据格：文本必须包在 `Text` 里；`clamp` 用来兜住用户自己写长的原因。 */
function TextCell(props: { value: string; width: number; tone?: Tone; clamp?: number }): SolidChild {
  return (
    <TableCell style={{ width: props.width, flexShrink: 0 }}>
      <Text
        style={{
          fontSize: fontSize.sm,
          color: props.tone ? toneColor(props.tone) : palette.text,
          lineClamp: props.clamp,
        }}
      >
        {props.value}
      </Text>
    </TableCell>
  );
}

function Page(): SolidChild {
  const store = session();
  const [view, setView] = createSignal<EngineBanlist | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [revision, setRevision] = createSignal(0);

  // 台账是磁盘上的文件：按下刷新/重新加载时重读一遍（revision 就是那个触发点）。
  const ledger = createMemo(() => {
    revision();
    return store.ledger().entries;
  });

  const jsonLines = createMemo(() => JSON.stringify(view()?.data ?? null, null, 2).split("\n"));

  const load = async (reload: boolean): Promise<void> => {
    const result = await store.loadBanlist(reload);
    setLoaded(true);
    if (result === null || result === "no-control") {
      setError(
        "读不到服务器上的名单：面板没接上这台服务器，或者它没有回话。先在首页把服务器启动起来，再点「刷新」；原因也可以在动作记录里找。",
      );
      return;
    }
    if (!result.ok) {
      setError("这份名单读不出来：服务器没有回话，或者名单内容坏了。点「刷新」再试一次，详细原因记在动作记录里。");
      return;
    }
    setError(null);
    setView({ file: result.view.file, data: result.view.data, reload: result.view.reload });
    setRevision((value) => value + 1);
  };

  // 进页面先读一次（不重载引擎名单：读文件不需要控制口，重新加载才要）。
  createEffect(() => {
    void load(false);
  });

  return (
    <View
      style={{
        flexGrow: 1,
        minHeight: 0,
        minWidth: 0,
        flexDirection: "column",
        gap: space.lg,
        padding: space.xl,
        // 外壳的内容区没有滚动容器：两个卡片（台账 + 引擎名单）叠起来比视口高，页面自己滚。
        overflow: "scroll",
      }}
    >
      <PageHeader
        title="封禁名单"
        icon="lucide:box"
        description="面板记录的封禁，和服务器上的名单。面板记的是你在这里做过的操作，服务器只记最后结果，两边可能对不上。"
        actions={
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Action label="重新加载名单" icon="lucide:refresh-cw" onPress={() => void load(true)} />
            <Action label="刷新" icon="lucide:refresh-cw" onPress={() => void load(false)} />
          </View>
        }
      />

      <Note
        tone="warning"
        text="服务器收到封禁指令后通常不会回话。所以这里只说面板发过什么操作、名单里记了什么，不代表一定封住了 —— 让那个玩家重连一次才能确认。"
      />

      <Card
        title="面板记录的封禁"
        icon="lucide:clipboard-list"
        tone="info"
        subtitle="只有这里记着封多久、为什么封、什么时候到期（服务器不存这些）"
      >
        {ledger().length === 0 ? (
          <EmptyHint
            compact
            icon="lucide:clipboard-list"
            title="还没有封禁记录"
            description="面板只记从这里发出的封禁：去玩家列表封一个人，这里才会出现条目。"
          />
        ) : (
          <Table accessibilityLabel="面板记录的封禁">
            <TableHeader>
              <TableRow>
                <HeadCell label="对象" grow />
                <HeadCell label="类型" width={116} />
                <HeadCell label="原因" width={240} />
                <HeadCell label="到期" width={176} />
                <HeadCell label="状态" width={96} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {ledger().map((entry) => (
                <TableRow>
                  <TableCell style={{ flexGrow: 1, minWidth: 200, flexShrink: 0 }}>
                    <View style={{ flexDirection: "column", gap: 2, minWidth: 0 }}>
                      <Text style={{ fontSize: fontSize.sm, color: palette.text }}>{entry.name || "（名字为空）"}</Text>
                      <Text style={{ fontFamily: font.mono, fontSize: fontSize.xs, color: palette.textDim }}>
                        {`玩家 ID ${entry.id64} · 当时填的 ${entry.target} · 记于 ${formatRelative(entry.issuedAt)}`}
                      </Text>
                    </View>
                  </TableCell>
                  <TextCell
                    value={entry.minutes > 0 ? `临时 ${entry.minutes} 分钟` : "永久"}
                    width={116}
                    tone={entry.minutes > 0 ? "warning" : "danger"}
                  />
                  <TextCell value={entry.reason || "—（没有写原因）"} width={240} clamp={2} />
                  <TextCell value={entry.expiresAt > 0 ? formatDateTime(entry.expiresAt) : "—"} width={176} />
                  <TextCell
                    value={entry.state === "unbanned" ? "已解封" : "封禁中"}
                    width={96}
                    tone={entry.state === "unbanned" ? "success" : "danger"}
                  />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Note
          tone="info"
          text="临时封禁到期时，面板会在服务器运行期间自动解封。服务器没在运行、或者机器重启过，自动解封就不会发生，记录会一直停在封禁中 —— 那时去玩家列表手动解封。解封只是面板记的一笔，服务器那边是不是真的解开了，要让那个玩家重连确认。"
        />
      </Card>

      <Card title="服务器上的名单" icon="lucide:box" tone="accent" subtitle="服务器自己写下的原始内容">
        {error() ? <Note tone="danger" text={error() ?? ""} /> : null}
        {!loaded() ? (
          <Text style={{ fontSize: fontSize.md, color: palette.textDim }}>正在读名单…</Text>
        ) : (
          <KeyValueList
            rows={[
              {
                label: "名单状态",
                value: view()?.file ? "已找到服务器写下的名单" : "还没写下来",
                tone: view()?.file ? undefined : "warning",
              },
            ]}
          />
        )}
        {view()?.reload ? <ReceiptNote receipt={view()!.reload!} /> : null}
        {loaded() && view()?.file === null ? (
          <EmptyHint
            compact
            icon="lucide:box"
            title="服务器上还没有名单"
            description="服务器只在自己封过人之后才会写下这份名单。没找到它，说明它还没封过谁 —— 可以回玩家列表确认一下。"
          />
        ) : null}
        {loaded() && view()?.file ? (
          <View style={{ gap: space.sm, minWidth: 0 }}>
            <Note tone="info" text="下面这段是服务器自己写下来的原始内容，面板不改写，也不解释它的写法。" />
            <Scrollable
              axis="both"
              style={{
                height: 320,
                minHeight: 0,
                backgroundColor: palette.log,
                borderRadius: radius.md,
                padding: space.md,
              }}
            >
              <View style={{ flexDirection: "column", gap: 2, minWidth: 0 }}>
                {jsonLines().map((line) => (
                  <Text style={{ fontFamily: font.mono, fontSize: fontSize.sm, color: palette.logLine }}>{line}</Text>
                ))}
              </View>
            </Scrollable>
          </View>
        ) : null}
      </Card>
    </View>
  );
}
