import type { Announcement, AnnouncementsFile } from "@server/announcements";
/**
 * 公告：服务端轮播 / 进场文案（`platform/datatable/chat_announcements.csv`）。
 *
 * 版式约定（UI 重做后）：
 *  1. 表格只做**概览**（类型 / 标签 / 文案 / 颜色 / 时长），改一行点那行的 ⋯ → 编辑弹窗；
 *     过去每行六个输入框铺满整屏，八列里五列是数字，没人愿意在表格里调秒数。
 *  2. 页面上只留两条结论：改完什么时候生效、现在到底发不发；其余取值规则进弹窗与提示。
 *  3. 保存只有一个入口（页头），改了才亮。
 *
 * 行为不变：表格里编辑的是**本机草稿**，按「保存文案」才写回文件；行内编辑就地写回行对象，
 * 保存时按行读（换引用会让输入框失焦，改回 `rows` 引用重建会踩到同一个坑）。
 */
import { Text, View, type SolidChild } from "@solid-gpui/core";
import {
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@solid-gpui/core/components";
import { createEffect, createSignal } from "@solid-gpui/core/runtime";
import { createFileRoute, useNavigate } from "@solid-gpui/router";
import {
  Action,
  Card,
  Chip,
  EmptyHint,
  Fold,
  FormDialog,
  FormRow,
  IconAction,
  Note,
  PageHeader,
  RowMenu,
  PageScroll,
} from "../../components/ui";
import { session } from "../../lib/session";
import { font, fontSize, palette, space } from "../../lib/theme";

export const Route = createFileRoute("/config/announcements")({ component: Page });

/** 新行：引擎的默认值都留空（它自己会按 8 / 2 / 60 / 10 兜底）。 */
const BLANK_ROW: Announcement = { kind: "rotate", tag: "", text: "", color: "", sustain: "", fade: "", wait: "" };

const KIND_ITEMS = [
  {
    key: "kind",
    items: [
      { key: "rotate", label: "轮播", description: "定时循环播给所有人" },
      { key: "welcome", label: "进场", description: "玩家加入时单独发给他" },
    ],
  },
];

const COLOR_HELP =
  "留空＝默认色；也可以写 white / red / gold / green / cyan / rainbow，或直接写「255 80 80」这种取值。";
const TIMING_HELP = "留空＝服务器默认：停留 8 秒、淡出 2 秒；间隔轮播 60 秒、进场 10 秒。三项都是秒数，可以留空。";

const HEAD_STYLE = { fontSize: fontSize.xs, color: palette.textDim } as const;

/** 一行的编辑器（弹窗内）：六个字段一次改完，确定时才写回那一行的草稿。 */
function RowDialog(props: {
  row: Announcement | null;
  adding: boolean;
  onClose: () => void;
  onSave: (row: Announcement) => void;
}): SolidChild {
  const [draft, setDraft] = createSignal<Announcement>({ ...BLANK_ROW });

  // 弹窗是同一个组件实例：换一行（或从「新增」切到「编辑」）时把草稿换成新的那一份，
  // 否则第二次打开会带着上一行的内容。输入过程中 `row` 引用不变，不会打断打字。
  createEffect<Announcement | null, Announcement | null | undefined>((previous) => {
    const row = props.row;
    if (previous !== undefined && previous !== row) setDraft({ ...(row ?? BLANK_ROW) });
    return row;
  }, undefined);

  return (
    <FormDialog
      open={props.row !== null}
      title={props.adding ? "新增公告" : "编辑公告"}
      okText="确定"
      width={520}
      onClose={props.onClose}
      onOk={() => props.onSave(draft())}
    >
      <FormRow label="类型">
        <Select
          accessibilityLabel="公告类型"
          items={KIND_ITEMS}
          value={draft().kind}
          size="small"
          onChange={(change) => {
            if (change.value === "welcome" || change.value === "rotate") setDraft({ ...draft(), kind: change.value });
          }}
        />
      </FormRow>
      <FormRow label="标签" help="显示在文案前面的方括号，例如 [Flowstate]。">
        <Input
          value={draft().tag}
          placeholder="[Flowstate]"
          ariaLabel="公告标签"
          onChange={(change) => setDraft({ ...draft(), tag: change.value })}
        />
      </FormRow>
      <FormRow label="文案" help="正文不超过 64 字。">
        <Input
          value={draft().text}
          placeholder="≤ 64 字"
          ariaLabel="公告正文"
          onChange={(change) => setDraft({ ...draft(), text: change.value })}
        />
      </FormRow>
      <FormRow label="颜色" help={COLOR_HELP}>
        <Input
          value={draft().color}
          placeholder="留空 / gold"
          ariaLabel="公告颜色"
          onChange={(change) => setDraft({ ...draft(), color: change.value })}
        />
      </FormRow>
      <FormRow label="停留 / 淡出 / 间隔（秒）" help={TIMING_HELP}>
        <View style={{ flexDirection: "row", gap: space.sm, minWidth: 0 }}>
          <Input
            value={draft().sustain}
            placeholder="8"
            ariaLabel="停留秒数"
            style={{ width: 0, flexGrow: 1 }}
            onChange={(change) => setDraft({ ...draft(), sustain: change.value })}
          />
          <Input
            value={draft().fade}
            placeholder="2"
            ariaLabel="淡出秒数"
            style={{ width: 0, flexGrow: 1 }}
            onChange={(change) => setDraft({ ...draft(), fade: change.value })}
          />
          <Input
            value={draft().wait}
            placeholder="60 / 10"
            ariaLabel="间隔秒数"
            style={{ width: 0, flexGrow: 1 }}
            onChange={(change) => setDraft({ ...draft(), wait: change.value })}
          />
        </View>
      </FormRow>
    </FormDialog>
  );
}

/** 概览表：一行的全部字段摊成一行文字，改点 ⋯。 */
function OverviewTable(props: {
  rows: Announcement[];
  onEdit: (row: Announcement) => void;
  onRemove: (row: Announcement) => void;
}): SolidChild {
  return (
    <Table size="small" accessibilityLabel="服务器公告文案">
      <TableHeader size="small">
        <TableRow size="small">
          <TableHead size="small" style={{ width: 72, flexShrink: 0 }}>
            <Text style={HEAD_STYLE}>类型</Text>
          </TableHead>
          <TableHead size="small" style={{ width: 116, flexShrink: 0 }}>
            <Text style={HEAD_STYLE}>标签</Text>
          </TableHead>
          <TableHead size="small" style={{ width: 0, flexGrow: 1, flexShrink: 0 }}>
            <Text style={HEAD_STYLE}>文案</Text>
          </TableHead>
          <TableHead size="small" style={{ width: 104, flexShrink: 0 }}>
            <Text style={HEAD_STYLE}>颜色</Text>
          </TableHead>
          <TableHead size="small" style={{ width: 168, flexShrink: 0 }}>
            <Text style={HEAD_STYLE}>停留 / 淡出 / 间隔</Text>
          </TableHead>
          <TableHead size="small" style={{ width: 56, flexShrink: 0 }}>
            <Text style={HEAD_STYLE} />
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody size="small">
        {props.rows.map((row) => (
          <TableRow size="small">
            <TableCell size="small" style={{ width: 72, flexShrink: 0 }}>
              <Text style={{ fontSize: fontSize.sm, color: palette.text }}>
                {row.kind === "welcome" ? "进场" : "轮播"}
              </Text>
            </TableCell>
            <TableCell size="small" style={{ width: 116, flexShrink: 0 }}>
              <Text style={{ fontSize: fontSize.sm, fontFamily: font.mono, color: palette.textMuted }}>
                {row.tag || "—"}
              </Text>
            </TableCell>
            <TableCell size="small" style={{ width: 0, flexGrow: 1, minWidth: 200, flexShrink: 0 }}>
              <Text style={{ fontSize: fontSize.sm, color: palette.text, lineClamp: 2 }}>
                {row.text || "（还没写文案）"}
              </Text>
            </TableCell>
            <TableCell size="small" style={{ width: 104, flexShrink: 0 }}>
              <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>{row.color || "默认"}</Text>
            </TableCell>
            <TableCell size="small" style={{ width: 168, flexShrink: 0 }}>
              <Text style={{ fontSize: fontSize.sm, fontFamily: font.mono, color: palette.textDim }}>
                {`${row.sustain || 8} / ${row.fade || 2} / ${row.wait || (row.kind === "welcome" ? 10 : 60)}`}
              </Text>
            </TableCell>
            <TableCell size="small" style={{ width: 56, flexShrink: 0 }}>
              <RowMenu
                label="这一行的操作"
                items={[
                  { id: "edit", label: "编辑…", icon: "lucide:text-cursor-input" },
                  { id: "remove", label: "删除", icon: "lucide:trash-2", tone: "danger", hint: "保存后才写回服务器" },
                ]}
                onSelect={(id) => {
                  if (id === "edit") props.onEdit(row);
                  if (id === "remove") props.onRemove(row);
                }}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Page(): SolidChild {
  const store = session();
  const navigate = useNavigate();
  const [file, setFile] = createSignal<AnnouncementsFile | null>(null);
  const [rows, setRows] = createSignal<Announcement[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [failed, setFailed] = createSignal(false);
  // 编辑是就地写回行对象（不写 rows 信号），所以要一个额外的触发信号把「有改动」带起来。
  const [edited, setEdited] = createSignal(false);
  const [editing, setEditing] = createSignal<Announcement | null>(null);
  const [adding, setAdding] = createSignal(false);

  /** 读文件：`null` = 还没有选服务器版本（引擎文件在版本目录里）。 */
  async function reload(): Promise<void> {
    setLoading(true);
    const loaded = await store.run("读取公告", () => store.loadAnnouncements());
    setLoading(false);
    if (loaded === undefined) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setFile(loaded);
    setRows(loaded === null ? [] : loaded.rows.map((row) => Object.assign({}, row)));
    setEdited(false);
  }

  void reload();

  const dirty = () => {
    const original = file();
    if (original === null || !edited()) return false;
    return JSON.stringify(rows()) !== JSON.stringify(original.rows);
  };

  async function saveTexts(): Promise<void> {
    const saved = rows().map((row) => Object.assign({}, row));
    if (!(await store.saveAnnouncements(saved))) return;
    setFile((previous) => (previous === null ? previous : { ...previous, rows: saved }));
    setEdited(false);
  }

  return (
    <PageScroll style={{ gap: space.lg, padding: space.xl }}>
      <PageHeader
        title="公告"
        icon="lucide:bell"
        description="轮播（定时播给所有人）与进场（玩家加入时发给他）的文案。"
        actions={
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
            {dirty() ? <Chip tone="warning" label="有未保存改动" icon="lucide:triangle-alert" /> : null}
            <IconAction
              icon="lucide:refresh-cw"
              label="重新读一遍文件（丢弃未保存的改动）"
              disabled={loading()}
              onPress={() => void reload()}
            />
            <Action label="立即广播" icon="lucide:bell" onPress={() => void store.broadcast()} />
            <Action
              label="保存文案"
              icon="lucide:check"
              tone="info"
              variant="solid"
              disabled={!dirty()}
              onPress={() => void saveTexts()}
            />
          </View>
        }
      />

      <Note text="改完要换图或重启服务器才会生效；「立即广播」只是让服务器现在念一遍已加载的文案，它不回话，效果要有人在游戏里看到才算。" />

      {store.settings().announceRotate === "on" ? null : (
        <Note
          tone="warning"
          text="设置里的「公告轮播」现在是关闭的（服务器默认）：文案照写，但一条都不会发。"
          action={
            <Action
              label="去设置"
              icon="lucide:settings"
              compact
              onPress={() => void navigate({ to: "/config/server" })}
            />
          }
        />
      )}

      {loading() ? (
        <Note text="正在读取公告文案…" />
      ) : failed() ? (
        <Note
          tone="danger"
          text="读不到公告文案：这次读取失败了，原因见动作记录；也可以先去「服务器列表」选一个版本。"
        />
      ) : file() === null ? (
        <EmptyHint
          icon="lucide:folder-open"
          title="还没有选服务器版本"
          description="公告文案表跟着服务器文件走，先选一个版本再回来读。"
          action={
            <Action label="去服务器列表" icon="lucide:layers" onPress={() => void navigate({ to: "/server/list" })} />
          }
        />
      ) : (
        <Card
          title="文案表"
          icon="lucide:bell"
          tone="info"
          subtitle="本机草稿，点「保存文案」才写回服务器"
          actions={
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Chip tone="neutral" label={`${rows().length} 行`} />
              <IconAction
                icon="lucide:plus"
                label="新增一条"
                onPress={() => {
                  setEditing({ ...BLANK_ROW });
                  setAdding(true);
                }}
              />
            </View>
          }
        >
          {rows().length === 0 ? (
            <EmptyHint
              compact
              icon="lucide:bell"
              title="还没有一条公告文案"
              description="用右上角的 + 加一条；保存时会保留文件原有的注释与表头。"
            />
          ) : (
            <OverviewTable
              rows={rows()}
              onEdit={(row) => {
                setAdding(false);
                // 传原对象引用：保存时按引用就地合并回 rows()；弹窗自己拷一份草稿。
                setEditing(row);
              }}
              onRemove={(row) => {
                setRows((list) => list.filter((item) => item !== row));
                setEdited(true);
              }}
            />
          )}

          <Fold label="颜色与时长怎么填？">
            <View style={{ gap: space.xs, minWidth: 0 }}>
              <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>{COLOR_HELP}</Text>
              <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>{TIMING_HELP}</Text>
              <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>
                表里显示的是留空时服务器实际会用的默认值。
              </Text>
            </View>
          </Fold>
        </Card>
      )}

      <RowDialog
        row={editing()}
        adding={adding()}
        onSave={(next) => {
          const target = editing();
          if (target === null) return;
          if (adding()) setRows((list) => [...list, next]);
          // 就地合并：换引用会让表格重建（正在输入的那一行会失焦）。
          else Object.assign(target, next);
          setEdited(true);
          setEditing(null);
          setAdding(false);
        }}
        onClose={() => {
          setEditing(null);
          setAdding(false);
        }}
      />
    </PageScroll>
  );
}
