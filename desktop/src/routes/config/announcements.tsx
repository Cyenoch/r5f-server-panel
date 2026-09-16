import type { Announcement, AnnouncementsFile } from "@server/announcements";
/**
 * 公告：服务端轮播 / 进场文案（`platform/datatable/chat_announcements.csv`）。
 *
 * 表格里编辑的是**本机草稿**，按「保存文案」才写回文件；引擎只在换图或重启后读这份文件，
 * 所以页面必须把「什么时候真正生效」说清楚（文件头自述也是这么写的）。
 *
 * 行状态：每行的输入框由行内 signal 驱动，改动同时**就地**写回那一行的对象 ——
 * `mapArray` 按引用复用行节点，换引用会让正在输入的那一行被重建、输入框当场失焦。
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
import { createSignal } from "@solid-gpui/core/runtime";
import { createFileRoute, useNavigate } from "@solid-gpui/router";
import { Action, Card, Chip, EmptyHint, Note, PageHeader, PageScroll } from "../../components/ui";
import { session } from "../../lib/session";
import { fontSize, palette, space } from "../../lib/theme";

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

const HEAD_STYLE = { fontSize: fontSize.xs, color: palette.textDim } as const;

/** 单元格里的单行输入：只负责显示与回调，值由调用方的 signal 管。 */
function CellInput(props: {
  value: string;
  width: number;
  placeholder: string;
  onInput: (value: string) => void;
}): SolidChild {
  return (
    <View style={{ width: props.width, minWidth: 0 }}>
      <Input
        value={props.value}
        size="xsmall"
        placeholder={props.placeholder}
        onChange={(change) => props.onInput(change.value)}
      />
    </View>
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

  const table = (): SolidChild => (
    <Card
      title="文案表"
      icon="lucide:bell"
      tone="info"
      subtitle="本机草稿，点「保存文案」才写回服务器"
      actions={<Chip tone="neutral" label={`${rows().length} 行`} />}
    >
      {rows().length === 0 ? (
        <EmptyHint
          compact
          icon="lucide:bell"
          title="还没有一条公告文案"
          description="点下面的「新增一行」加一条；保存时会保留原有的注释与表头。"
        />
      ) : (
        <Table size="small" accessibilityLabel="服务器公告文案">
          <TableHeader size="small">
            <TableRow size="small">
              <TableHead size="small">
                <Text style={HEAD_STYLE}>类型</Text>
              </TableHead>
              <TableHead size="small">
                <Text style={HEAD_STYLE}>标签</Text>
              </TableHead>
              <TableHead size="small">
                <Text style={HEAD_STYLE}>文案</Text>
              </TableHead>
              <TableHead size="small">
                <Text style={HEAD_STYLE}>颜色</Text>
              </TableHead>
              <TableHead size="small">
                <Text style={HEAD_STYLE}>停留秒</Text>
              </TableHead>
              <TableHead size="small">
                <Text style={HEAD_STYLE}>淡出秒</Text>
              </TableHead>
              <TableHead size="small">
                <Text style={HEAD_STYLE}>间隔秒</Text>
              </TableHead>
              <TableHead size="small">
                <Text style={HEAD_STYLE}>操作</Text>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody size="small">
            {rows().map((row) => {
              const [draft, setDraft] = createSignal<Announcement>({ ...row });
              /** 输入框用行内 signal 驱动；值就地写回行对象，保存时按行读。 */
              const edit = (patch: Partial<Announcement>): void => {
                const next: Announcement = { ...draft(), ...patch };
                setDraft(next);
                // 就地合并：换引用会让 mapArray 重建这一行，正在输入的输入框会当场失焦。
                Object.assign(row, next);
                setEdited(true);
              };
              return (
                <TableRow size="small">
                  <TableCell size="small">
                    <View style={{ width: 132, minWidth: 0 }}>
                      <Select
                        items={KIND_ITEMS}
                        value={draft().kind}
                        size="xsmall"
                        onChange={(change) => {
                          if (change.value === "welcome" || change.value === "rotate") {
                            edit({ kind: change.value });
                          }
                        }}
                      />
                    </View>
                  </TableCell>
                  <TableCell size="small">
                    <CellInput
                      value={draft().tag}
                      width={84}
                      placeholder="[Flowstate]"
                      onInput={(value) => edit({ tag: value })}
                    />
                  </TableCell>
                  <TableCell size="small">
                    <CellInput
                      value={draft().text}
                      width={220}
                      placeholder="≤ 64 字"
                      onInput={(value) => edit({ text: value })}
                    />
                  </TableCell>
                  <TableCell size="small">
                    <CellInput
                      value={draft().color}
                      width={96}
                      placeholder="留空 / gold"
                      onInput={(value) => edit({ color: value })}
                    />
                  </TableCell>
                  <TableCell size="small">
                    <CellInput
                      value={draft().sustain}
                      width={64}
                      placeholder="8"
                      onInput={(value) => edit({ sustain: value })}
                    />
                  </TableCell>
                  <TableCell size="small">
                    <CellInput
                      value={draft().fade}
                      width={64}
                      placeholder="2"
                      onInput={(value) => edit({ fade: value })}
                    />
                  </TableCell>
                  <TableCell size="small">
                    <CellInput
                      value={draft().wait}
                      width={64}
                      placeholder="60 / 10"
                      onInput={(value) => edit({ wait: value })}
                    />
                  </TableCell>
                  <TableCell size="small">
                    <Action
                      label="删除"
                      icon="lucide:trash-2"
                      tone="danger"
                      variant="ghost"
                      compact
                      tooltip="从草稿里去掉这一行（保存后才写回服务器）"
                      onPress={() => {
                        setRows((list) => list.filter((item) => item !== row));
                        setEdited(true);
                      }}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <Action
          label="新增一行"
          icon="lucide:plus"
          onPress={() => {
            setRows((list) => [...list, { ...BLANK_ROW }]);
            setEdited(true);
          }}
        />
        <Action label="保存文案" icon="lucide:check" tone="info" variant="solid" onPress={() => void saveTexts()} />
      </View>
    </Card>
  );

  return (
    <PageScroll
      style={{
        flexGrow: 1,
        minHeight: 0,
        minWidth: 0,
        flexDirection: "column",
        gap: space.lg,
        padding: space.xl,
        overflow: "scroll",
      }}
    >
      <PageHeader
        title="公告"
        icon="lucide:bell"
        description="服务器的轮播与进场文案：改完点「保存文案」，写回服务器的公告文案表。"
        actions={
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
            {dirty() ? <Chip tone="warning" label="有未保存改动" icon="lucide:triangle-alert" /> : null}
            <Action label="重新读取" icon="lucide:refresh-cw" onPress={() => void reload()} disabled={loading()} />
            <Action label="立即广播" icon="lucide:bell" tone="info" onPress={() => void store.broadcast()} />
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

      <Note text="轮播＝定时循环播给所有人；进场＝玩家加入时单独发给他。" />
      <Note
        tone="warning"
        text="改完要换图或重启服务器才会生效——服务器只在启动和换图时读这份文案；「立即广播」只是让它现在念一遍已经加载的内容。"
      />
      <Note
        tone="warning"
        text="广播发出去没有回话（服务器不会回应这条指令），到底念没念、屏幕上什么样，要有人在游戏里确认。"
      />
      <Note text="每条文案：正文 ≤ 64 字；颜色可留空，或写 white / red / gold / green / cyan / rainbow，也可以直接写「255 80 80」这种取值；停留、淡出、间隔留空就用服务器默认（停留 8 秒、淡出 2 秒；轮播间隔 60 秒，进场 10 秒）。" />
      {store.settings().announceRotate === "on" ? null : (
        <Note
          tone="warning"
          text="设置里的「公告轮播」现在是关闭的（服务器默认）：文案照写，但一条都不会发。去「服务器配置」把它改成开启，再重启服务器。"
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
          text="读不到公告文案：这次读取失败了，原因见下面的动作记录；也可以先去「服务器列表」选一个版本。"
        />
      ) : file() === null ? (
        <EmptyHint
          icon="lucide:folder-open"
          title="还没有选服务器版本"
          description="公告文案表跟着服务器文件走，要先在「服务器列表」里选一个版本，再回来读。"
          action={
            <Action label="去服务器列表" icon="lucide:layers" onPress={() => void navigate({ to: "/server/list" })} />
          }
        />
      ) : (
        table()
      )}
    </PageScroll>
  );
}
