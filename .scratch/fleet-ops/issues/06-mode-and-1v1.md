# 06 · 模式目录与固定 1v1

- **Status**: `ready-for-human`（实现已完成；剩余步骤需要人或真人玩家在场）
- **Blocked by**: 无（与 05 并行）
- **归属文件**: `src/catalog.ts`、`src/settings-fields.ts`、`src/commands.ts`、`src/cli.tsx`、`src/tui.tsx`、`README.md`
- **契约**: `spec.md` §契约 7（1v1）

## Target

把"玩法"从手打 playlist id 变成**从真实模式目录里选**，并把服务器**先固定成 1v1**。

## 证据

- 模式目录在 `platform/playlists_r5_patch.txt`；1v1 家族实测存在：

```
// Flowstate fs_1v1 (bridge port)
fs_1v1 {
  inherit survival_dev
  vars {
    r5f_mode_group "flowstate"; r5f_mode_family 1v1; r5f_mode_family_title "1v1"
    r5f_mode_family_order 20; r5f_mode_order 20; r5f_mode_title "1v1"
    name "FS 1v1"; description "1v1"; lobbytitle "1v1"
    fs_1v1_use_realms 1                 // 并发对决隔离
    fs_1v1_locked_set "blue"            // white|blue|purple|gold|none
    custom_1v1_weapons_primary ""       // 自定义武器
    fs_1v1_rotate_mp_rr_arena_habitat 1 // 11 个轮换图开关
    player_max_fight_distance 2000; rest_grace 5.0
  }
  gamemodes { fs_1v1 { maps { mp_rr_aqueduct 1 … } } }
}
fs_lgduels_1v1 { … r5f_mode_family 1v1; r5f_mode_title "LG Duels" … }   // R99 上膛决斗
```

- 一步热切：`bridge_setmode <playlist> <map>`（dll 描述 + 用法字符串："Apply a playlist and change level in one step."）。
- 对外上报：1v1 对战统计会 POST 到 `https://play.r5flowstate.org/stats/1v1/ingest`（`fs_stats_url`，**置空即关闭**；`fs_stats_host_key`、`fs_http_timeout`）。同族还有 `spire_matchmaking_hostname`（默认 `play.r5flowstate.org`）、`spire_matchmaking_insecure`（允许明文 HTTP）、`-offline`（关闭 matchmaking）。

## Change

### `src/catalog.ts`（扩展，沿用 keyvalues-tools）

```ts
export type ModeEntry = {
  id: string;
  title: string;
  family: string;
  familyTitle: string;
  familyOrder: number;
  order: number;
  map: string;
  maps: string[];
  blurb: string;
};
export type ModeFamily = { key: string; title: string; order: number; modes: ModeEntry[] };

export function parseModes(text: string): ModeEntry[]; // 只取带 r5f_mode_* 元数据的 playlist
export function groupByFamily(modes: ModeEntry[]): ModeFamily[];
export function mapsForPlaylist(modes: ModeEntry[], playlistId: string): string[];
export async function collectModes(versionDir: string): Promise<ModeFamily[]>;
```

- 解析要点：`Playlists { … }` 下每个条目取 `vars.r5f_mode_family/family_title/family_order`、`r5f_mode_title/mode_order/mode_map/mode_blurb`、`name`；地图来自该条目的 `gamemodes { <gamemode> { maps { <map> 1 … } } }`（可能多个 gamemode，合并去重）。
- 没有 `r5f_mode_*` 的 playlist（BR 内部玩法）**不进目录**。

### CLI（`src/cli.tsx`）

```
mode list [--json]              按家族分组：family → [id, title, 地图数, 默认地图]
mode set <playlist> [map]       bridge_setmode <playlist> <map>；map 省略时用该模式默认地图（再不行用首个地图）
```

- `mode set` 在无运行实例时：提示需先启动（该命令是运行期热切，不写启动设置）。
- 回执走 ticket 02 分类（预期 `silent`）。

### 设置（`src/settings-fields.ts`）

- **模式（playlist）**：picker 选项来自 `collectModes`，按家族分组显示（`1v1` 家族排最前），保留 `（手动输入…）` 兜底。
- **地图**：当所选 playlist 是已知模式时，地图候选 = `mapsForPlaylist(...)`；否则回落到现有地图清单。
- 新增 **`statsUpload`**（1v1 数据上报）：选项 `保持引擎默认（上报到 play.r5flowstate.org）` / `关闭上报（+fs_stats_url ""）`；选择关闭时启动参数追加 `+fs_stats_url ""`。

### 面板（`src/tui.tsx`）

- 设置页模式项：显示 `模式  fs_1v1（1v1 · FS 1v1）`；选中后 `x` = **立即切换**（`mode set`，仅运行中可用，未运行则说明）。
- 体检页新增一行：`对外上报`（当前设置：默认 / 已关闭；默认时显示目标端点）。

### 数据（由集成者执行）

- `r5-server.json`：`playlist` 固定为 `fs_1v1`（用户指令："游戏模式先固定 1v1"），地图改为该模式内的一张（`mp_rr_arena_habitat`，属 11 张轮换图之一）。

## Acceptance

1. `mode list` 列出 `1v1` 家族至少 `fs_1v1`、`fs_lgduels_1v1`，各带地图数与默认地图；`--json` 结构稳定。
2. 设置页模式选择器按家族分组；选 `fs_1v1` 后地图候选与该模式地图一致。
3. 启动命令包含 `+launchplaylist fs_1v1`（`--dry-run`/日志可见），`status` 正常。
4. `mode set fs_1v1 mp_rr_arena_habitat` → 发送 `bridge_setmode`，回执如实；实例不崩溃、`status` 仍可读（验证后不要留在测试地图上，或明确告诉用户当前处于哪张图）。
5. 体检页显示对外上报状态；关掉后启动参数含 `+fs_stats_url ""`。

## 验证配方

- 真机：`mode set` 前先 `status` 记录 hostname；发送后确认日志无 `doesn't exist`，且实例仍响应 `status`。
- 目录解析：对真实 `playlists_r5_patch.txt` 断言 `fs_1v1` 的 `family === "1v1"`、地图数 ≥ 11、`maps` 含 `mp_rr_arena_habitat`。
- `README.md` 增补：1v1 怎么切、`fs_1v1_locked_set`/`fs_1v1_rotate_*` 等模式内参数在哪改（playlist 文件）、上报开关。

## 注释

- `fs_1v1` 的 `map_name` 是空串（引擎注释：加载屏用实际加载的关卡名）→ 别指望从这里取默认地图，用 `r5f_mode_map` 或地图清单。
- 1v1 实际对局体验（realm 隔离、锁定套装）本机无法验证（需真人）→ 保持 `需验证`。

## 实现记录（2026-09-14）

- 已完成：`catalog.modes`（12 家族 / 41 模式，按 `r5f_mode_*` 元数据）、`mode list`（家族分组）、`mode set <playlist> [map]`（`bridge_setmode`）、设置页模式选择器（家族分组、1v1 最前、地图收敛到该模式清单）、`x` 立即切换、对外上报可见性与开关（`statsUpload` → `+fs_stats_url ""`）。
- 实测证据：`fs_1v1` family = `1v1`、11 张图、含 `mp_rr_arena_habitat`；`fs_lgduels_1v1` 同族 12 图；`mode set fs_1v1 mp_rr_arena_habitat` 触发引擎换模式行、回执如实；无实例时 `mode set` 退 2。
- 数据变更（用户指令"游戏模式先固定 1v1"）：`r5-server.json` 的 `playlist = fs_1v1`，地图改为该模式内的 `mp_rr_arena_habitat`（原 `mp_rr_district` 不在 1v1 清单内）；`defaultSettings` 同步。备份在 `.tmp/r5-server.json.bak`。
- 待真人：1v1 对局体验（realm 隔离、锁定套装）。
