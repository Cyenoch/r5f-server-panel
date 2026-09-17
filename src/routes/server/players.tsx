/**
 * 玩家列表：引擎 `status` 解析出来的在线名单 + 踢 / 封禁 / 解封 / 机器人。
 *
 * 版式约定（UI 重做后）：
 *  1. 审核动作全部走弹窗（封禁、解封、加机器人）—— 表单不再平铺在正文里；
 *  2. 行内只留两个图标动作（踢、封禁），名字进悬停提示；
 *  3. 边界与机制（机器人不可封禁、引擎可能静默、玩家 ID 与会话编号的区别）走 `Help`，
 *     不写成段落。页面上只剩"现在能不能点"这一个结论。
 *
 * 两件必须如实说的事没变：引擎对 `kick` / `ban` 可能**静默**（回执原文进动作记录，页面不写"已生效"）；
 * 机器人（`uniqueid === "0"`）没有 id64，封不了 —— 按钮直接禁用并在提示里说原因。
 */
import { Text, View, type SolidChild } from "@solid-gpui/core";
import {
  Clipboard,
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
import {
  Action,
  Chip,
  Confirm,
  EmptyHint,
  FormDialog,
  FormRow,
  IconAction,
  Note,
  PageHeader,
  PageScroll,
} from "../../components/ui";
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

/** 引擎的状态原样来自 `status`；只有实测见过的 `active` 给中文，其余照抄，不猜。 */
function stateLabel(state: string): string {
  return state === "active" ? "游戏中" : state;
}

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

/** 被封禁的对象：弹窗只认这两样（会话编号用于显示，玩家 ID 才是解封的凭据）。 */
type BanTarget = { userid: string; name: string; id64: string };

function Page(): SolidChild {
  const store = session();
  const [addOpen, setAddOpen] = createSignal(false);
  const [clearOpen, setClearOpen] = createSignal(false);
  const [unbanOpen, setUnbanOpen] = createSignal(false);
  const [banTarget, setBanTarget] = createSignal<BanTarget | null>(null);

  const [count, setCount] = createSignal("1");
  const [botName, setBotName] = createSignal("");
  const [team, setTeam] = createSignal<0 | 1 | 2>(0);
  const [minutes, setMinutes] = createSignal("");
  const [reason, setReason] = createSignal("");
  const [unbanId, setUnbanId] = createSignal("");
  const [problem, setProblem] = createSignal<string | null>(null);

  const players = createMemo(() => store.players());
  const bots = createMemo(() => players().filter((player) => player.uniqueid === "0").length);
  const busy = () => store.busy() !== null;
  const addBusy = () => store.busy() === "添加机器人";

  /** 空态只有一句：读不到名单的原因分三种，各说各的，不铺垫。 */
  const emptyReason = (): string => {
    const instance = store.instance();
    if (!instance || !instance.alive) return "服务器没在运行。";
    if (!instance.hosted) return "面板没接上这台服务器 —— 重启它让面板来启动。";
    return "现在没有人在线；想看列表长什么样，先加几个机器人。";
  };

  /** 加机器人的前置检查：引擎的「具名 / 批量」是两条路，各自的约束在这里说破。 */
  const addIssue = (): string | null => {
    const name = botName().trim();
    if (name.length > 0) return /\s/.test(name) ? "名字不能带空格（服务器按空格拆名字与队伍）。" : null;
    const size = Number.parseInt(count().trim(), 10);
    return Number.isInteger(size) && size >= 1 ? null : "数量要填 ≥ 1 的整数。";
  };

  const submitBots = async (): Promise<void> => {
    const issue = addIssue();
    setProblem(issue);
    if (issue) return;
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
    const target = banTarget();
    const issue = banIssue();
    setProblem(issue);
    if (!target || issue) return;
    const raw = minutes().trim();
    const size = raw.length === 0 ? 0 : Number.parseInt(raw, 10);
    // 带时长/原因才走「引擎封 + 本机台账」那条路：台账里才有到期与原因（引擎不存）。
    await store.moderate("ban", target.userid, { minutes: size, reason: reason().trim() });
    setBanTarget(null);
  };

  const submitUnban = async (): Promise<void> => {
    const target = unbanId().trim();
    if (target.length === 0) {
      setProblem("先填要解封的玩家 ID。");
      return;
    }
    setProblem(null);
    const result = await store.moderate("unban", target);
    if (result !== undefined && result !== "no-control") {
      setUnbanId("");
      setUnbanOpen(false);
    }
  };

  return (
    <PageScroll style={{ gap: space.lg, padding: space.xl }}>
      <PageHeader
        title="玩家列表"
        icon="lucide:users"
        description="现在在线的玩家；踢人、封禁、解封都从这一页发出。"
        actions={
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <IconAction
              icon="lucide:refresh-cw"
              label="刷新名单"
              disabled={busy()}
              onPress={() => void store.refreshFast()}
            />
            <Action
              label="解封…"
              icon="lucide:check"
              disabled={busy()}
              onPress={() => {
                setProblem(null);
                setUnbanId("");
                setUnbanOpen(true);
              }}
            />
            <Action
              label="加机器人"
              icon="lucide:plus"
              tone="info"
              variant="solid"
              disabled={busy()}
              onPress={() => {
                setProblem(null);
                setAddOpen(true);
              }}
            />
            <IconAction
              icon="lucide:minus"
              label="清空机器人"
              tone="danger"
              disabled={busy() || bots() === 0}
              onPress={() => setClearOpen(true)}
            />
          </View>
        }
      />

      {store.playersError() ? <Note tone="danger" text={`读不到在线名单：${store.playersError()}`} /> : null}

      {players().length === 0 ? (
        <EmptyHint icon="lucide:users" title="没有玩家在线" description={emptyReason()} />
      ) : (
        <Table accessibilityLabel="在线玩家">
          <TableHeader>
            <TableRow>
              <HeadCell label="玩家" grow />
              <HeadCell label="会话编号" width={76} />
              <HeadCell label="玩家 ID" width={208} />
              <HeadCell label="状态" width={88} />
              <HeadCell label="ping" width={56} />
              <HeadCell label="操作" width={64} />
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
                <TableCell style={{ width: 208, flexShrink: 0 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, minWidth: 0 }}>
                    <Text
                      style={{
                        fontSize: fontSize.sm,
                        color: player.uniqueid === "0" ? palette.textDim : palette.text,
                        fontFamily: font.mono,
                      }}
                    >
                      {player.uniqueid === "0" ? "—" : player.uniqueid}
                    </Text>
                    {/* 解封要的就是这一串：让它就地可复制，省得去别处翻。 */}
                    {player.uniqueid === "0" ? null : (
                      <Clipboard value={player.uniqueid} tooltip="复制玩家 ID（解封要用它）" />
                    )}
                  </View>
                </TableCell>
                <TextCell
                  value={stateLabel(player.state) || "—"}
                  width={88}
                  tone={player.state === "active" ? palette.success : palette.text}
                />
                <TextCell value={player.ping || "—"} width={56} />
                <TableCell style={{ width: 64, flexShrink: 0 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                    <IconAction
                      icon="lucide:x"
                      label="踢出"
                      disabled={busy()}
                      onPress={() => void store.moderate("kick", player.userid)}
                    />
                    <IconAction
                      icon="lucide:square"
                      label={player.uniqueid === "0" ? "机器人不可封禁，只能踢" : "封禁…"}
                      tone="danger"
                      disabled={player.uniqueid === "0" || busy()}
                      onPress={() => {
                        setProblem(null);
                        setMinutes("");
                        setReason("");
                        setBanTarget({ userid: player.userid, name: player.name, id64: player.uniqueid });
                      }}
                    />
                  </View>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <FormDialog
        open={addOpen()}
        title="加机器人"
        okText="添加"
        busy={addBusy()}
        problem={problem()}
        onClose={() => setAddOpen(false)}
        onOk={() => void submitBots()}
      >
        <FormRow label="数量" help="不填名字时按数量批量生成，队伍由服务器自己分配。">
          <Input
            value={count()}
            placeholder="例如 8"
            ariaLabel="机器人数量"
            disabled={botName().trim().length > 0}
            onChange={(change) => setCount(change.value)}
          />
        </FormRow>
        <FormRow label="名字" help="填了名字就是具名机器人：一次只加一个，队伍按下面选。">
          <Input
            value={botName()}
            placeholder="留空则按数量批量生成"
            ariaLabel="机器人名字"
            cleanable
            onChange={(change) => setBotName(change.value)}
          />
        </FormRow>
        <FormRow label="队伍">
          <Select
            accessibilityLabel="机器人队伍"
            items={TEAM_ITEMS}
            value={String(team())}
            size="small"
            onChange={(change) => {
              const raw = change.value;
              setTeam(raw === "1" ? 1 : raw === "2" ? 2 : 0);
            }}
          />
        </FormRow>
      </FormDialog>

      <FormDialog
        open={banTarget() !== null}
        title={banTarget() ? `封禁 ${banTarget()!.name || "（名字为空）"}` : "封禁"}
        okText="封禁"
        okVariant="danger"
        problem={problem()}
        onClose={() => setBanTarget(null)}
        onOk={() => void submitBan()}
      >
        <View style={{ gap: space.xs, minWidth: 0 }}>
          <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>
            {banTarget() ? `会话编号 ${banTarget()!.userid} · 玩家 ID ${banTarget()!.id64}` : ""}
          </Text>
        </View>
        <FormRow label="时长（分钟）" help="留空 = 永久。临时封禁到期后由面板在服务器运行期间代发解封。">
          <Input
            value={minutes()}
            placeholder="留空 = 永久"
            ariaLabel="封禁时长（分钟）"
            cleanable
            onChange={(change) => setMinutes(change.value)}
          />
        </FormRow>
        <FormRow label="原因" help="原因与到期只写在本面板的封禁记录里，服务器不保存。">
          <Input
            value={reason()}
            placeholder="写给自己看"
            ariaLabel="封禁原因"
            cleanable
            onChange={(change) => setReason(change.value)}
          />
        </FormRow>
        <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>
          服务器通常不回话 —— 没回话不等于封住了，让对方重连一次才算确认。
        </Text>
      </FormDialog>

      <FormDialog
        open={unbanOpen()}
        title="解封"
        okText="解封"
        okVariant="success"
        problem={problem()}
        onClose={() => setUnbanOpen(false)}
        onOk={() => void submitUnban()}
      >
        <FormRow label="玩家 ID" help="会话编号每次重启都会重排，解封要用固定的玩家 ID；封禁名单页也能查到。">
          <Input
            value={unbanId()}
            placeholder="64 位数字"
            ariaLabel="要解封的玩家 ID"
            cleanable
            onChange={(change) => setUnbanId(change.value)}
          />
        </FormRow>
      </FormDialog>

      <Confirm
        open={clearOpen()}
        danger
        title="清空机器人"
        message={`会把 ${bots()} 个机器人全部踢掉，真人不受影响。一次没清干净可以再来一次。`}
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
