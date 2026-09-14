# 04 · 本次运行健康 + 日志分片

- **Status**: `ready-for-agent`
- **Blocked by**: 无
- **归属文件**: `src/inspect.ts`、`src/commands.ts`、`src/cli.tsx`、`src/tui.tsx`、`src/state.ts`
- **契约**: `spec.md` §契约 5（健康与日志分片）

## Target

两件事：

1. **"这次运行出没出问题"要能一眼看到**：引擎自己每次运行写一套日志目录（`latest.txt` 指向它），其中 `error.log` 非空就是真问题。
2. **日志不能再跨启动混在一起**：实测同一个 `版本-端口` 的日志文件里躺着 8 次启动横幅，面板会把上次运行的内容当成现在（`status` 解析刚为此打过补丁）。

## 证据

| 事实                                                                                                                                                      | 来源 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `platform/logs/server/latest.txt` 内容是本次运行的目录名（uuid，实测 `241ad8c3-7d55-4f2e-8a5a-0e3933c62b13`）                                             | 文件 |
| 该目录下有 `error.log` / `warning.log` / `script_warning.log`                                                                                             | 文件 |
| 健康运行：`error.log` **为空**；`warning.log` 有大量启动诊断（`[DETOUR] class … spills xmm0`、`[FIRE-CLOCK]`、`[ZIP-ATTACH]`、`Native(E):[dt_extend] …`） | 文件 |
| `Native(E)` **不是错误级别**：里面有 `CHostState::State_NewGame: Loading level`、`Installed NetKey` 等正常行                                              | 日志 |
| 同一日志文件里 8 次启动横幅 + 运行中再次出现 `Installed NetKey`                                                                                           | 日志 |

## Change

### 日志分片（`src/commands.ts` + `src/state.ts`）

- 启动时日志路径：`logs/<版本>-<端口>-<YYYYMMDD-HHMMSS>.log`（本地时间；`runid` 即文件名去掉前缀），写入 `state.runtime.logFile`。
- `state.logRetention`（新，默认 `10`）：启动时按文件名排序保留最新 N 个（文件名可字典序比较），删除更旧的；删除失败只告警，不阻断启动。
- `logs`（无参）：仍是本次运行的尾部跟随（行为不变）。
- `logs --all`：列出所有运行分片（文件名、大小、修改时间、是否本次），最新在前。
- `logs --run <文件名或 runid>`：读指定分片；不存在时给出可选列表。
- 停止/重启后 `state.runtime.logFile` 保持指向最后一次运行（现状），但 UI 要标"上次运行"。

### 健康采集（`src/inspect.ts`，新导出）

```ts
export type HealthFile = { path: string; exists: boolean; bytes: number; mtime: number; lines: string[] };
export type Health = {
  runId: string; // latest.txt 内容（目录 uuid），读不到则 ""
  runDir: string; // 绝对路径
  latestOk: boolean; // latest.txt 是否存在且指向存在的目录
  error: HealthFile; // error.log：bytes > 0 ⇒ 有真问题
  warning: HealthFile; // warning.log：只取最后 3 行做展示，不当作错误
  scriptWarning: HealthFile;
  notes: string[]; // 例如「error.log 非空：本次运行出现错误」/「latest.txt 缺失」
};
export async function collectHealth(state: State): Promise<Health>;
```

- 读取上限：每个文件最多读尾部 64 KB / 200 行（`error.log` 非空即报红，不需要全文）。
- **判级别按文件与词**，禁止按 `Native(E)/(F)` 前缀判错（实测前缀不代表级别）。

### CLI（`src/cli.tsx`）

```
health [--json]       人读：本次运行 id、error.log 状态（非空则显示前 3 行）、warning 计数、脚本告警有无
```

### 面板（`src/tui.tsx`）

- 体检页（`d`）新增"本次运行"块：run id、`error.log` 状态（非空 = 红色 + 首行摘要）、`warning.log` 行数、`script_warning.log` 有无。
- 日志区标题补上本次运行标识（`logs/<…>-<runid>.log`），停止后显示"（上次运行）"。
- 主页面状态行加"本次运行"标记，避免把历史横幅误读成当前。

## Acceptance

1. 连续两次 `start` → `logs/` 出现两个不同 `runid` 的分片；`logs --all` 都列出并标出本次。
2. 把 `logRetention` 设成 2 并再启动，最旧分片被删除。
3. `health` 在健康运行为：`error.log` 空、`latestOk=true`；手工向 `error.log` 追加一行后 `health` 报红（验证完必须还原该文件）。
4. 体检页显示同样结论；日志区标题含本次 run id。
5. 观察：跨启动不再混日志（新启动写新文件，旧文件不被追加）。

## 验证配方

- 真机两次启动（第二次前 `stop`），对比 `logs/` 目录与 `logs --all`。
- `health --json` 与直接读 `platform/logs/server/latest.txt` 的结果一致。
- 还原：测试期间的 `error.log` 改动必须回滚（版本目录里的引擎文件，改完恢复原状）。

## 注释

- `warning.log` 的 `[DETOUR]`/`[ZIP-ATTACH]` 是 R5F 改版启动自检的正常输出（该构建是带 Detour hook 的改版），**不要**当成故障。
- `Installed NetKey: '…'` 会出现在日志里（启动时 + 运行中至少一次），属运行期密钥 → README 的"分享日志前注意"里提一句。
