/**
 * 封禁名单：两样东西各说各话。
 *
 *  1. **本机台账**（`moderation.json`）：时长、原因、到期只有这里有 —— 引擎的 `ban` 只有一个参数，
 *     封了就是永久，本工具的"临时封禁"是靠这条记录 + 日志守护代发解封兑现的。台账行可以直接解封。
 *  2. **引擎名单**（`banlist.json`）：结构由引擎（Spire 侧）决定，这里原样打印。
 *
 * 能确认的只有文件里写了什么：引擎对 `ban` / `banlist_reload` **静默**，静默不是成功。
 * 「重新加载引擎名单」挂在引擎名单卡的右上角 —— 它只对这一张卡的内容有意义，不该和"刷新"并排。
 */
import { Text, View, type SolidChild } from "@solid-gpui/core";
import {
  Clipboard,
  Scrollable,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@solid-gpui/core/components";
import { createEffect, createMemo, createSignal } from "@solid-gpui/core/runtime";
import { createFileRoute } from "@solid-gpui/router";
import {
  Action,
  Card,
  Confirm,
  EmptyHint,
  Fold,
  IconAction,
  KeyValueList,
  Note,
  PageHeader,
  PageScroll,
  toneColor,
  type Tone,
} from "../../components/ui";
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

/** 伸缩列显式 width: 0；省略宽度会让原生 Table 用整行宽度作为 flex 基准。 */
function HeadCell(props: { label: string; width?: number; grow?: boolean }): SolidChild {
  return (
    <TableHead style={{ width: props.width ?? 0, flexGrow: props.grow ? 1 : undefined, flexShrink: 0 }}>
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
  const [unbanTarget, setUnbanTarget] = createSignal<{ id64: string; name: string } | null>(null);

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
      setError("读不到服务器上的名单：面板没接上这台服务器，或者它没有回话。");
      return;
    }
    if (!result.ok) {
      setError("这份名单读不出来：服务器没有回话，或者名单内容坏了。");
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
    <PageScroll style={{ gap: space.lg, padding: space.xl }}>
      <PageHeader
        title="封禁名单"
        icon="lucide:box"
        description="本面板发过的封禁，和服务器上的名单。"
        actions={
          <IconAction
            icon="lucide:refresh-cw"
            label="刷新（重新读台账与服务器名单）"
            onPress={() => void load(false)}
          />
        }
      />

      <Card
        title="本面板记录的封禁"
        icon="lucide:clipboard-list"
        tone="info"
        subtitle="封多久、为什么封只记在这里（服务器不存）"
      >
        {ledger().length === 0 ? (
          <EmptyHint
            compact
            icon="lucide:clipboard-list"
            title="还没有封禁记录"
            description="只记从这里发出的封禁；去玩家列表封一个人，这里才会出现条目。"
          />
        ) : (
          <Table accessibilityLabel="本面板记录的封禁">
            <TableHeader>
              <TableRow>
                <HeadCell label="对象" grow />
                <HeadCell label="时长" width={104} />
                <HeadCell label="原因" width={220} />
                <HeadCell label="到期" width={168} />
                <HeadCell label="状态" width={88} />
                <HeadCell label="操作" width={56} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {ledger().map((entry) => (
                <TableRow>
                  <TableCell style={{ width: 0, flexGrow: 1, minWidth: 220, flexShrink: 0 }}>
                    <View style={{ flexDirection: "column", gap: 2, minWidth: 0 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, minWidth: 0 }}>
                        <Text style={{ fontSize: fontSize.sm, color: palette.text }}>
                          {entry.name || "（名字为空）"}
                        </Text>
                        <Text style={{ fontFamily: font.mono, fontSize: fontSize.xs, color: palette.textDim }}>
                          {entry.id64}
                        </Text>
                        {/* 解封要的就是这一串：就地可复制，不用手抄。 */}
                        <Clipboard value={entry.id64} tooltip="复制玩家 ID" />
                      </View>
                      <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
                        {`封于 ${formatRelative(entry.issuedAt)}`}
                      </Text>
                    </View>
                  </TableCell>
                  <TextCell
                    value={entry.minutes > 0 ? `临时 ${entry.minutes} 分钟` : "永久"}
                    width={104}
                    tone={entry.minutes > 0 ? "warning" : "danger"}
                  />
                  <TextCell value={entry.reason || "—"} width={220} clamp={2} />
                  <TextCell value={entry.expiresAt > 0 ? formatDateTime(entry.expiresAt) : "—"} width={168} />
                  <TextCell
                    value={entry.state === "unbanned" ? "已解封" : "封禁中"}
                    width={88}
                    tone={entry.state === "unbanned" ? "success" : "danger"}
                  />
                  <TableCell style={{ width: 56, flexShrink: 0 }}>
                    <IconAction
                      icon="lucide:check"
                      label={entry.state === "unbanned" ? "已经解封过了" : "解除这个封禁"}
                      tone="success"
                      disabled={entry.state === "unbanned"}
                      onPress={() => setUnbanTarget({ id64: entry.id64, name: entry.name })}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Fold label="临时封禁什么时候会自动解封？">
          <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>
            到期时，面板会在服务器运行期间代发解封。服务器没在运行、或机器重启过，自动解封不会发生，
            记录会一直停在「封禁中」—— 那时在这里手动解封。服务器对解封通常不回话，是否真的解开要以对方重连为准。
          </Text>
        </Fold>
      </Card>

      <Card
        title="服务器上的名单"
        icon="lucide:box"
        tone="accent"
        subtitle={view()?.file ? view()!.file! : "服务器自己写下的原始内容"}
        actions={
          <Action
            label="重新加载引擎名单"
            icon="lucide:refresh-cw"
            variant="ghost"
            compact
            tooltip="让服务器重新读一遍名单文件（需要面板接上它）"
            onPress={() => void load(true)}
          />
        }
      >
        {error() ? <Note tone="danger" text={error() ?? ""} /> : null}
        {!loaded() ? (
          <Text style={{ fontSize: fontSize.md, color: palette.textDim }}>正在读名单…</Text>
        ) : (
          <KeyValueList
            rows={[
              {
                label: "名单文件",
                value: view()?.file ? "已找到" : "还没写下来（服务器还没封过谁）",
                tone: view()?.file ? "success" : "warning",
              },
            ]}
          />
        )}
        {view()?.reload ? (
          <Note
            tone={RECEIPT_TONE[view()!.reload!.kind]}
            text={`重新加载：${RECEIPT_LABEL[view()!.reload!.kind]}${
              view()!.reload!.kind === "silent" ? "（没有回话不等于已重新加载，以名单内容为准）" : ""
            }`}
          />
        ) : null}
        {loaded() && view()?.file ? (
          <Fold label="原始内容（排障用）">
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
          </Fold>
        ) : null}
      </Card>

      <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>
        服务器收到封禁和解封指令后通常不回话 —— 这两张单子只说明面板发过什么、文件里记了什么，让本人重连一次才能确认。
      </Text>

      <Confirm
        open={unbanTarget() !== null}
        title="解除封禁"
        message={`对 ${unbanTarget()?.name || "（名字为空）"}（${unbanTarget()?.id64 ?? ""}）发解封指令，并在台账里标成已解封。服务器通常不回话。`}
        confirmLabel="解封"
        onConfirm={() => {
          const target = unbanTarget();
          setUnbanTarget(null);
          if (target !== null) void store.moderate("unban", target.id64);
        }}
        onCancel={() => setUnbanTarget(null)}
      />
    </PageScroll>
  );
}
