# 05 · 公告（轮播文案 + 广播）

- **Status**: `ready-for-human`（实现已完成；剩余步骤需要人或真人玩家在场）
- **Blocked by**: 02（广播命令是静默类，必须走回执分类报告"引擎无回执"）
- **归属文件**: `src/announcements.ts`（新）、`src/commands.ts`、`src/cli.tsx`、`src/tui.tsx`、`src/keys.ts`、`package.json`
- **契约**: `spec.md` §契约 6（公告）

## Target

让服主能编辑服务器轮播公告的文案，并对在线玩家触发一次广播。引擎与 R5F 侧**已经具备**这套东西，我们只是接上：

- 文案表：`platform/datatable/chat_announcements.csv`（文件头自带 schema）
- 轮播脚本：`platform/scripts/vscripts/sv_chat_announcements.nut`
- 触发命令：`bridge_chat_announce`（dll 描述："Broadcast the rotating server chat announcements."；实测存在、**无回执**）

## 证据：CSV 的表头就是 schema（原文）

```csv
# kind:    rotate  = looping server messages
#          welcome = shown once after a player joins
# tag:     cyan prefix, e.g. [Flowstate]. Blank = none.
# text:    the line. Max 64 characters. Quote the cell if it has a comma.
# color:   blank/white, red, gold, green, cyan, rainbow, or 255 80 80
# sustain: seconds fully visible. Blank = 8
# fade:    seconds to fade out. Blank = 2
# wait:    rotate  = seconds until the next rotate line. Blank = 60
#          welcome = seconds after join before it shows. Blank = 10
kind,tag,text,color,sustain,fade,wait
string,string,string,string,float,float,float
rotate,[Flowstate],Have fun and be respectful.,,8,2,60
rotate,[Flowstate],Join the community at play.r5flowstate.org,,8,2,60
welcome,,Welcome to R5Flowstate! Good luck out there,green,8,2,10
```

生效时机（同一文件头自述）：**"Edit this file, then changelevel (or restart the dedi)."**

## Change

### 新模块 `src/announcements.ts`（用维护中的 CSV 包，不手搓）

依赖：`csv-parse`、`csv-stringify`（`bun add`；本仓库规则：配置格式用活跃维护的包解析）。

```ts
export type AnnouncementKind = "rotate" | "welcome";
export type Announcement = {
  kind: AnnouncementKind;
  tag: string;
  text: string;
  color: string;
  sustain: string;
  fade: string;
  wait: string;
};
export type AnnouncementsFile = { path: string; preamble: string; rows: Announcement[] };

/** preamble = 文件开头连续的注释块 + 表头行 + 类型行（原样保留，用于回写） */
export function parseAnnouncements(text: string, path?: string): AnnouncementsFile;
/** 回写：preamble 原样 + 数据行由 csv-stringify 生成（自动处理含逗号字段的引号） */
export function renderAnnouncements(file: AnnouncementsFile): string;
/** 校验（返回中文错误列表）；text ≤ 64 字符、kind/color 取值受控、数值字段可空 */
export function validateAnnouncement(row: Announcement): string[];
```

- 解析用 `csv-parse/sync`：`{ comment: "#", skip_empty_lines: true, relax_column_count: true }`；类型行（值为 `string`/`float`）要跳过但**保留**在 preamble 里。
- **往返约束**：对未改动的文件，`renderAnnouncements(parseAnnouncements(text)) === text`（字节一致，含行尾风格）。这是本 ticket 的硬验收。

### CLI（`src/cli.tsx`）

```
announcements list [--json]
announcements add --text "…" [--kind rotate|welcome] [--tag "…"] [--color white|red|gold|green|cyan|rainbow|"255 80 80"]
                       [--sustain n] [--fade n] [--wait n]
announcements remove <index>            索引来自 list（1 起）
announce                              触发 bridge_chat_announce，走回执分类（预期 silent）
```

- `add`/`remove` 写文件前必须 `validateAnnouncement` 通过；写文件用**行级替换**（preamble 保留），失败不写。
- 输出提示生效条件（changelevel 或重启）。

### 面板（`src/tui.tsx` + `src/keys.ts`）

- 新页面 **公告**（键 `n`）：列出 `kind/tag/text/color/wait`，`↑↓` 选择、`a` 新增（居中对话框，字段按 schema）、`d` 删除选中、`t` 触发广播、`r` 重新读取、`Esc` 返回。
- 页面固定提示："改动在 changelevel 或重启后生效"；`t` 之后显示回执结论（引擎无回执 + 需真人在场确认）。
- 主界面 footer 补上 `n 公告`。

## Acceptance

1. 对真实 `chat_announcements.csv`：解析 → 回写 → **字节完全一致**（`cmp` 级）。
2. `announcements list` 列出 3 行真实数据（2 rotate + 1 welcome）。
3. `announcements add --text "测试公告，含逗号"` → 文件被追加一行且引号正确；`list` 能看到；`remove` 后文件回到原状。
4. `announcements add --text "<65 字符以上>"` → 退出码 1，文件不变。
5. `announce` → 回执为"已发送（引擎无回执）"。
6. 面板公告页可浏览/新增/删除/触发，Esc 返回后主界面正常。

## 验证配方

- 真机：先备份 CSV 到 `.tmp`，跑完整往返断言，再确认 `cmp` 一致。
- 线上触发：`announce` 后读日志确认无 `Command '…' doesn't exist`（即是静默成功，而非被拒）。
- 收尾：CSV 必须恢复为用户原始内容（除非用户明确要加公告）。

## 注释

- 不要实现 `say`/`chat_announce`（实测不存在）。
- 广播的**可见效果**需要真人在场 → `roadmap.md` 保持 `需验证`。
- 文案里的 `play.r5flowstate.org` 是 R5F 社区地址（默认文案），换服请自行改文案。

## 实现记录（2026-09-14）

- 已完成：`src/announcements.ts`（`csv-parse` + `csv-stringify`，preamble 原样保留）、`announcements list|add|remove`、`announce`、面板公告页（`n`：列表 / 新增对话框 / 删除 / 触发 / 重新读取）。
- 实测证据：真实 CSV `parse → render` **字节完全一致**（869 B，sha256 与原件相同）；含逗号文案正确加引号且 `remove` 后 sha256 还原；65 字符被拒退 1 且不写文件；CRLF 往返通过；`announce` 后引擎无 `doesn't exist`（命令被接受）。
- 待真人：广播的可见效果（需真人在场看聊天框）。
