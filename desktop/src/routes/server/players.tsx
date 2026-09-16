/**
 * 玩家列表：引擎 `status` 解析出来的在线名单 + 踢 / 封 / 解封 + 机器人。
 *
 * 两件事必须如实说：
 *  1. 引擎对 `kick` / `ban` 可能**静默**（不回话）—— 静默不等于成功；回执原文由 store 落进动作记录，
 *     页面不写"已生效"。
 *  2. 机器人（`uniqueid === "0"`）没有 id64，封不了 —— 按钮直接禁用并说明原因，不给引擎去报错。
 */
import { Text, View, type SolidChild } from "@solid-gpui/core";
import {
  Dialog,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type ChoiceGroup,
} from "@solid-gpui/core/components";
import { createMemo, createSignal } from "@solid-gpui/core/runtime";
import { createFileRoute } from "@solid-gpui/router";
import { Action, Card, Chip, Confirm, EmptyHint, Note, PageHeader, Toolbar, PageScroll } from "../../components/ui";
import { session } from "../../lib/session";
import { font, fontSize, palette, space } from "../../lib/theme";

export const Route = createFileRoute("/server/players")({ component: Page });

/** 队伍 0/1/2 原样交给引擎（`sv_addbot <name> <team>`）；面板不替它编语义。 */
const TEAM_ITEMS: ChoiceGroup[] = [
  {
    key: "team",
    items: [
      { key: "0", label: "队伍 0（默认）" },
      { key: "1", label: "队伍 1" },
      { key: "2", label: "队伍 2" },
    ],
  },
];

/** 伸缩列显式 width: 0；省略宽度会让原生 Table 用整行宽度作为 flex 基准。 */
function HeadCell(props: { label: string; width?: number; grow?: boolean }): SolidChild {
  return (
    <TableHead style={{ width: props.width ?? 0, flexGrow: props.grow ? 1 : undefined, flexShrink: 0 }}>
      <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>{props.label}</Text>
    </TableHead>
  );
}

/** 数据格：文本必须包在 `Text` 里（渲染器不接受裸文本）；id64 这类按位读的值用等宽字体。 */
function TextCell(props: { value: string; width: number; mono?: boolean; tone?: string }): SolidChild {
  return (
    <TableCell style={{ width: props.width, flexShrink: 0 }}>
      <Text
        style={{
          fontSize: fontSize.sm,
          color: props.tone ?? palette.text,
          fontFamily: props.mono ? font.mono : undefined,
        }}
      >
        {props.value}
      </Text>
    </TableCell>
  );
}

function Page(): SolidChild {
  const store = session();
  const [addOpen, setAddOpen] = createSignal(false);
  const [clearOpen, setClearOpen] = createSignal(false);
  const [count, setCount] = createSignal("1");
  const [botName, setBotName] = createSignal("");
  const [team, setTeam] = createSignal<0 | 1 | 2>(0);
  const [banUserId, setBanUserId] = createSignal("");
  const [banName, setBanName] = createSignal("");
  const [minutes, setMinutes] = createSignal("");
  const [reason, setReason] = createSignal("");
  const [unban, setUnban] = createSignal("");

  const players = createMemo(() => store.players());
  const bots = createMemo(() => players().filter((player) => player.uniqueid === "0").length);

  /** 空态里那句解释：读不到名单的原因分三种，逐个说清楚，不含糊。 */
  const emptyReason = (): string => {
    const instance = store.instance();
    if (!instance || !instance.alive) return "服务器没在运行 —— 启动后才能看到谁在线。";
    if (!instance.hosted) return "面板没接上这台服务器，读不到在线名单 —— 重启这台服务器让它由面板启动。";
    return "现在没有人在线（机器人在服务器里也算玩家）—— 可以点 加机器人 先试试。";
  };

  /** 加机器人的前置检查：引擎的「具名 / 批量」是两条路，各自的约束在这里说破。 */
  const addIssue = (): string | null => {
    const name = botName().trim();
    if (name.length > 0)
      return /\s/.test(name) ? "名字不能带空格 —— 服务器按空格把名字和队伍分开，换个名字再试。" : null;
    const size = Number.parseInt(count().trim(), 10);
    return Number.isInteger(size) && size >= 1 ? null : "数量要填 ≥ 1 的整数 —— 填 0 个机器人没有意义，这里直接拦下。";
  };

  const submitBots = async (): Promise<void> => {
    // 有本地就知道不合法的输入就先拦住（弹窗里那条黄色说明举着原因），不发给引擎。
    if (addIssue()) return;
    // 名字与数量在引擎侧互斥（sv_addbot 一次只加一个具名机器人），所以按分支只传一条路。
    const name = botName().trim();
    if (name.length > 0) await store.addBots({ name, team: team() });
    else await store.addBots({ count: Number.parseInt(count().trim(), 10), team: team() });
    setAddOpen(false);
    setBotName("");
    setCount("1");
  };

  /** 时长留空 = 永久；填了就要求是 ≥ 0 的整数。 */
  const banIssue = (): string | null => {
    const raw = minutes().trim();
    if (raw.length === 0) return null;
    const size = Number.parseInt(raw, 10);
    return Number.isInteger(size) && size >= 0 ? null : "时长要填 ≥ 0 的整数；留空 = 永久。";
  };

  const submitBan = async (): Promise<void> => {
    const target = banUserId();
    if (target.length === 0 || banIssue()) return;
    const raw = minutes().trim();
    const size = raw.length === 0 ? 0 : Number.parseInt(raw, 10);
    // 带时长/原因才走「引擎封 + 本机台账」那条路：台账里才有到期与原因（引擎不存）。
    await store.moderate("ban", target, { minutes: size, reason: reason().trim() });
    setBanUserId("");
  };

  const submitUnban = async (): Promise<void> => {
    const target = unban().trim();
    if (target.length === 0) {
      store.notice("error", "解除封禁", "先填要解封的玩家 ID —— 玩家列表里那一列可以复制。");
      return;
    }
    const result = await store.moderate("unban", target);
    if (result !== undefined && result !== "no-control") setUnban("");
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
        // 外壳的内容区没有滚动容器：页面自己滚，超高的部分（表格 + 解封卡片）才够得着。
        overflow: "scroll",
      }}
    >
      <PageHeader
        title="玩家列表"
        icon="lucide:users"
        description="现在在线的玩家和机器人；踢人、封禁、解封都在这一页。"
      />

      <Toolbar>
        <Action
          label="刷新"
          icon="lucide:refresh-cw"
          onPress={() => void store.refreshFast()}
          disabled={store.busy() !== null}
        />
        <Action label="加机器人" icon="lucide:plus" onPress={() => setAddOpen(true)} disabled={store.busy() !== null} />
        <Action
          label="清空机器人"
          icon="lucide:minus"
          tone="danger"
          onPress={() => setClearOpen(true)}
          disabled={store.busy() !== null}
        />
        {store.busy() ? (
          <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>{`正在${store.busy()}…`}</Text>
        ) : null}
      </Toolbar>

      {store.playersError() ? (
        <Note
          tone="danger"
          text={`读不到在线名单：${store.playersError()}　先点 刷新 再试一次，还是不行就重启服务器。`}
        />
      ) : null}

      {players().length === 0 ? (
        <EmptyHint icon="lucide:users" title="没有玩家在线" description={emptyReason()} />
      ) : (
        <Table accessibilityLabel="在线玩家">
          <TableHeader>
            <TableRow>
              <HeadCell label="玩家" grow />
              <HeadCell label="会话编号" width={76} />
              <HeadCell label="玩家 ID" width={176} />
              <HeadCell label="状态" width={92} />
              <HeadCell label="ping" width={64} />
              <HeadCell label="操作" width={152} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {players().map((player) => (
              <TableRow>
                <TableCell style={{ width: 0, flexGrow: 1, minWidth: 160, flexShrink: 0 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 0 }}>
                    <Text style={{ fontSize: fontSize.sm, color: palette.text }}>{player.name || "（名字为空）"}</Text>
                    {player.uniqueid === "0" ? <Chip tone="accent" label="机器人" /> : null}
                  </View>
                </TableCell>
                <TextCell value={player.userid} width={76} mono />
                <TextCell value={player.uniqueid === "0" ? "—" : player.uniqueid} width={176} mono />
                <TextCell
                  value={player.state || "—"}
                  width={92}
                  tone={player.state === "active" ? palette.success : palette.text}
                />
                <TextCell value={player.ping || "—"} width={64} />
                <TableCell style={{ width: 152, flexShrink: 0 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                    <Action
                      label="踢"
                      compact
                      onPress={() => void store.moderate("kick", player.userid)}
                      disabled={store.busy() !== null}
                    />
                    <Action
                      label="封禁"
                      compact
                      tone="danger"
                      disabled={player.uniqueid === "0" || store.busy() !== null}
                      tooltip={player.uniqueid === "0" ? "机器人不可封禁，只能踢" : undefined}
                      onPress={() => {
                        setMinutes("");
                        setReason("");
                        setBanName(player.name);
                        setBanUserId(player.userid);
                      }}
                    />
                  </View>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Card title="解封" icon="lucide:check" subtitle="解封要玩家 ID；会话编号只是这次开服时的临时编号">
        <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>
          为什么玩家 ID 比会话编号靠得住：会话编号每次重启服务器都会重新排，拿它解封可能解错人；玩家 ID
          是这个账号的固定编号，重启也不会变。 本机台账里每条封禁都记着当时的玩家 ID，去封禁名单页可以查。
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 0 }}>
          <View style={{ width: 320, flexShrink: 0 }}>
            <Input
              value={unban()}
              placeholder="玩家 ID（64 位数字）"
              ariaLabel="要解封的玩家 ID"
              cleanable
              onChange={(change) => setUnban(change.value)}
            />
          </View>
          <Action
            label="解封"
            icon="lucide:check"
            variant="solid"
            tone="success"
            onPress={() => void submitUnban()}
            disabled={unban().trim().length === 0 || store.busy() !== null}
          />
          {unban().trim().length === 0 ? (
            <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>先填要解封的玩家 ID。</Text>
          ) : null}
        </View>
      </Card>

      <Dialog
        open={addOpen()}
        title="加机器人"
        width={460}
        buttons={{ okText: "添加", cancelText: "取消", okVariant: "primary", showCancel: true, closeOnOk: false }}
        onOpenChange={(value) => {
          if (!value.open) setAddOpen(false);
        }}
        onAction={(action) => {
          if (action.kind === "ok") void submitBots();
          else setAddOpen(false);
        }}
      >
        <View style={{ gap: space.md }}>
          <View style={{ gap: space.xs }}>
            <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>数量</Text>
            <Input
              value={count()}
              placeholder="例如 8"
              ariaLabel="机器人数量"
              disabled={botName().trim().length > 0}
              onChange={(change) => setCount(change.value)}
            />
          </View>
          <View style={{ gap: space.xs }}>
            <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>名字（可选）</Text>
            <Input
              value={botName()}
              placeholder="留空则按数量批量生成"
              ariaLabel="机器人名字"
              cleanable
              onChange={(change) => setBotName(change.value)}
            />
          </View>
          <View style={{ gap: space.xs }}>
            <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>队伍</Text>
            <Select
              accessibilityLabel="机器人队伍"
              items={TEAM_ITEMS}
              value={String(team())}
              placeholder="队伍"
              size="small"
              onChange={(change) => {
                const raw = change.value;
                setTeam(raw === "1" ? 1 : raw === "2" ? 2 : 0);
              }}
            />
          </View>
          <Note
            tone="info"
            text="填了名字就是具名机器人：一次只加一个，队伍生效；不填名字走批量，数量生效、队伍由服务器自己分配。"
          />
          {addIssue() ? <Note tone="warning" text={addIssue() ?? ""} /> : null}
        </View>
      </Dialog>

      <Dialog
        open={banUserId().length > 0}
        title="封禁玩家"
        width={460}
        buttons={{ okText: "封禁", cancelText: "取消", okVariant: "danger", showCancel: true, closeOnOk: false }}
        onOpenChange={(value) => {
          if (!value.open) setBanUserId("");
        }}
        onAction={(action) => {
          if (action.kind === "ok") void submitBan();
          else setBanUserId("");
        }}
      >
        <View style={{ gap: space.md }}>
          <Text style={{ fontSize: fontSize.md, color: palette.text }}>
            {`${banName() || "（名字为空）"} · 会话编号 ${banUserId()}`}
          </Text>
          <View style={{ gap: space.xs }}>
            <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>时长（分钟，留空 = 永久）</Text>
            <Input
              value={minutes()}
              placeholder="留空 = 永久"
              ariaLabel="封禁时长（分钟）"
              cleanable
              onChange={(change) => setMinutes(change.value)}
            />
          </View>
          <View style={{ gap: space.xs }}>
            <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>原因</Text>
            <Input
              value={reason()}
              placeholder="写给自己看的（服务器不保存原因）"
              ariaLabel="封禁原因"
              cleanable
              onChange={(change) => setReason(change.value)}
            />
          </View>
          <Note
            tone="warning"
            text={
              minutes().trim().length === 0
                ? "永久封禁：只在本机台账里留一条记录（原因为证），不会自动解封。服务器对封禁可能没有回话 —— 没回话不等于成功，去玩家客户端确认。"
                : "时长和原因只记在本机台账里：到期由日志守护代发解封；守护不在时（服务器已停、机器重启）不会执行。服务器对封禁可能没有回话 —— 没回话不等于成功。"
            }
          />
          {banIssue() ? <Note tone="danger" text={banIssue() ?? ""} /> : null}
        </View>
      </Dialog>

      <Confirm
        open={clearOpen()}
        danger
        title="清空机器人"
        message={`会把机器人全部踢掉（现在有 ${bots()} 个）。踢掉和名单更新之间有一点延迟，一次没清干净可以再来一次；真人玩家不受影响。`}
        confirmLabel="清空"
        onConfirm={() => {
          setClearOpen(false);
          void store.clearBots();
        }}
        onCancel={() => setClearOpen(false)}
      />
    </PageScroll>
  );
}
