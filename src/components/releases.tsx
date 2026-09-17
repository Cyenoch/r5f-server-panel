import type { VersionInfo } from "@server/panel";
import {
  type InstallProgress,
  ReleaseError,
  type ReleaseInfo,
  checkRelease,
  findInstalled,
  installRelease,
  isInstalling,
  releaseDelta,
} from "@server/releases";
/**
 * 服务端版本页：官方发布的最新版本、本机已经装好的版本、下载与安装。
 *
 * 关于「最新」这件事，界面只讲它真知道的部分：
 *
 *  1. **版本号来自文件名。** 官方只有 `https://r5flowstate.org/dedi` 这一个入口，
 *     它跳到 CDN 上的 `r5f-dedi-X.Y.Z.zip`；没有清单、没有校验值、也没有签名。
 *     所以「最新」= 官方现在给出的那个文件名里的版本号，按**数字**比大小
 *     （`1.0.9` < `1.0.10`，按字符串比刚好反过来）。页内「这个版本号是怎么认出来的」
 *     把边界说明白，而不是给一个「已验证」的假徽章。
 *  2. **不做校验和。** 没有可对照的摘要就不假装校验过。安装时真正校验的是：来源域名、
 *     文件名形状、包内路径（绝对路径/`..`/符号链接一律拒绝）、解压后的三件套、
 *     目录名与文件名是否同一个版本 —— 全部由 `@server/releases` 执行。
 *  3. **装版本 ≠ 换版本。** 安装只往实例根目录里加一个版本目录，不写 state、不动正在
 *     跑的实例；哪个实例用哪个版本由实例自己决定 —— 这页没有全局版本选择器。
 *
 * 写法上有两条硬约束（Solid 的组件体只跑一次，本机踩过）：
 *  - `signal()` 与 `props.x` 的读取必须留在 JSX 表达式里；取进普通常量就是把当时的
 *    快照钉死，检查结果、进度条、已装列表都不会再变。
 *  - 因此只把「需要一次收窄」的整张卡片做成组件（`LatestCard`），其余显示片段都是拿具体
 *    值调用的普通函数，在 JSX 表达式里求值。
 */
import { Icon, Text, View, type SolidChild } from "@solid-gpui/core";
import { createSignal } from "@solid-gpui/core/runtime";
import { formatBytes, formatRelative } from "../lib/format";
import { session } from "../lib/session";
import { font, fontSize, palette, radius, space } from "../lib/theme";
import { Action, Card, Chip, EmptyHint, Fold, Help, KeyValueList, Note, PageHeader, PageScroll } from "./ui";

/** busy 标签与 `lib/session` 里的动作名一致：界面要能分辨「在统计」和「在安装」。 */
const SCAN_LABEL = "统计占用空间";

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 失败码 → 短标题；正文一律用 `ReleaseError` 自己那句可读的话。 */
function failureTitle(err: unknown): string {
  if (!(err instanceof ReleaseError)) return "检查失败";
  switch (err.code) {
    case "network":
      return "连不上官方地址";
    case "origin":
      return "地址不在官方域名下";
    case "filename":
      return "认不出官方包名";
    case "exists":
      return "这个版本已经装过了";
    case "busy":
      return "已有安装在进行";
    case "incomplete":
      return "下载不完整";
    case "space":
      return "磁盘空间不足";
    case "archive":
      return "压缩包不可用";
    case "triad":
      return "内容不像服务端";
    case "cancelled":
      return "已取消";
    default:
      return "安装失败";
  }
}

/**
 * 安装中的那条：阶段 + 字节数 + 进度条 + 取消说明。
 * 官方没给体积、压缩包也没声明总量时（`percent === null`）只显示已下载/已解开的量。
 */
function progressRow(progress: InstallProgress, name: string): SolidChild {
  const total = progress.totalBytes;
  const percent =
    total === null || total <= 0 ? null : Math.min(100, Math.max(0, (progress.receivedBytes / total) * 100));
  const phase =
    progress.phase === "extracting" ? "正在解压到临时目录" : progress.phase === "complete" ? "已经放好" : "正在下载";
  const bytes =
    total === null
      ? formatBytes(progress.receivedBytes)
      : `${formatBytes(progress.receivedBytes)} / ${formatBytes(total)}`;
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 0 }}>
        <Icon name="lucide:clock" size={14} color={palette.info} />
        <Text style={{ fontSize: fontSize.sm, color: palette.text }}>{`${phase} ${name}`}</Text>
        <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>{bytes}</Text>
      </View>
      {percent === null ? null : (
        <View
          style={{
            height: 6,
            flexDirection: "row",
            widthPercent: 100,
            backgroundColor: palette.panelRaised,
            borderRadius: 3,
          }}
        >
          <View style={{ height: 6, widthPercent: percent, backgroundColor: palette.info, borderRadius: 3 }} />
        </View>
      )}
      <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
        下载与解压都在实例根目录下的临时目录里做，装完才整体改名成版本目录；取消或失败不会留下半个版本。
      </Text>
    </View>
  );
}

function failureNote(err: unknown, onRetry: () => void): SolidChild {
  return (
    <Note
      tone="danger"
      text={`${failureTitle(err)}：${reason(err)}`}
      action={<Action label="再试一次" icon="lucide:refresh-cw" tone="danger" compact onPress={onRetry} />}
    />
  );
}

/** 已装版本的一行：名字 + 体积/构建 + 目录位置。在 `map` 里按具体值调用。 */
function installedRow(version: VersionInfo): SolidChild {
  const rows = [
    {
      label: "占用空间",
      value: version.sizeBytes >= 0 ? formatBytes(version.sizeBytes) : "还没统计（点右上「统计占用空间」）",
    },
    ...(version.files >= 0 ? [{ label: "文件数", value: `${version.files} 个` }] : []),
    ...(version.build.length > 0 ? [{ label: "构建", value: version.build }] : []),
    ...(version.gameVersion.length > 0 ? [{ label: "游戏版本", value: version.gameVersion }] : []),
  ];
  return (
    <View
      style={{
        padding: space.md,
        gap: space.sm,
        backgroundColor: palette.panelRaised,
        borderRadius: radius.md,
        minWidth: 0,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 0 }}>
        <Icon name="lucide:package" size={15} color={palette.textMuted} />
        <Text style={{ fontSize: fontSize.md, color: palette.text }}>{version.name}</Text>
        {version.version === null ? <Chip tone="warning" label="目录名没有版本号" /> : null}
      </View>
      <KeyValueList rows={rows} />
      <Fold label="目录位置">
        <Text style={{ fontSize: fontSize.sm, color: palette.textDim, fontFamily: font.mono }}>{version.path}</Text>
      </Fold>
    </View>
  );
}

/** 对比结论：官方最新 vs 本机已装。只用版本数字判断，不猜。 */
function deltaNote(release: ReleaseInfo, installed: VersionInfo[]): SolidChild {
  const exact = installed.find((version) => version.name === release.name);
  if (exact !== undefined) {
    return <Note tone="success" text={`本机已经有 ${exact.name} 了，不会重复安装，也不会覆盖它。`} />;
  }
  const matched = findInstalled(release, installed);
  const delta = releaseDelta(release, installed);
  if (delta === "same" && matched !== null) {
    return (
      <Note
        tone="warning"
        text={`本机有 ${matched.name}：版本号与官方一致，但目录名不同。装官方这个会新增一个 ${release.name} 目录，现有目录原样保留。`}
      />
    );
  }
  if (delta === "older" && matched !== null) {
    return (
      <Note
        tone="warning"
        text={`官方现在给的是 ${release.version}，比本机已装的 ${matched.name} 旧 —— 发布可能回滚过。装它不会删掉本机任何版本。`}
      />
    );
  }
  if (delta === "newer") {
    const newest = installed.find((version) => version.version !== null);
    return (
      <Note
        tone="info"
        text={
          newest === undefined
            ? "本机还没有可比的服务端版本，装上它才算有可用的服务端。"
            : `比本机最新的已装版本（${newest.name}）新。`
        }
      />
    );
  }
  return <Note tone="warning" text="本机已装目录的版本号认不出来，这页没法替你比较新旧。" />;
}

/** 版本号是怎么来的：官方只给文件名，没有清单也没有校验值。 */
function provenanceFold(): SolidChild {
  return (
    <Fold label="这个版本号是怎么认出来的">
      <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>
        官方只提供 https://r5flowstate.org/dedi 这一个入口，它跳到 CDN 上的 r5f-dedi-版本号.zip。
        没有清单文件、没有校验值、也没有签名，所以版本号取自**文件名**，并按数字比大小（1.0.9 比 1.0.10
        旧）；面板**不校验内容摘要** —— 没有可对照的摘要。
      </Text>
      <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>
        安装时真正校验的是：地址必须是 https 且域名属于 r5flowstate.org；文件名必须是纯文件名的
        r5f-dedi-版本号.zip（带路径分隔符、..、盘符一律拒绝）；包里不能有绝对路径、跳出目录的路径或符号链接；
        解压出来的目录要同时含 r5apex_ds.exe、server.dll、loader.dll，目录名里的版本还要与文件名一致。
      </Text>
    </Fold>
  );
}

/**
 * 官方最新版本卡片。做成组件只为一次收窄 `release`（具体值进、`release()!` 不出现在页面里）；
 * 其余会变的东西（进度、已装列表、失败）一律读 props —— Solid 的 props 是取值器，读在 JSX 里就跟着更新。
 */
function LatestCard(props: {
  release: ReleaseInfo;
  installed: VersionInfo[];
  /** 这一页发起的安装：进度与失败。 */
  progress: InstallProgress | null;
  installError: unknown;
  /** 本进程里有安装在跑（可能不是这一页发起的）。 */
  installing: boolean;
  /** 有别的动作（统计占用空间、刷新列表…）在跑。 */
  busy: boolean;
  onInstall: () => void;
  onCancel: () => void;
  onRetry: () => void;
}): SolidChild {
  const exact = (): VersionInfo | undefined => props.installed.find((version) => version.name === props.release.name);
  const sameNumber = (): VersionInfo | null => findInstalled(props.release, props.installed);
  const locked = (): boolean => props.installing || props.busy;
  return (
    <Card
      title={`官方最新：${props.release.name}`}
      subtitle={props.release.filename}
      icon="lucide:download"
      tone="info"
      actions={
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          {props.progress === null ? null : (
            <Action
              label="取消安装"
              icon="lucide:x"
              tone="danger"
              compact
              tooltip="停掉下载或解压；临时文件会清掉，本机版本不变"
              onPress={props.onCancel}
            />
          )}
          <Action
            label={exact() === undefined ? "下载并安装" : "已装过"}
            icon={exact() === undefined ? "lucide:download" : "lucide:check"}
            tone="info"
            variant="solid"
            compact
            disabled={locked() || exact() !== undefined}
            tooltip={
              exact() !== undefined
                ? `本机已经有 ${props.release.name}，不覆盖已有安装`
                : props.installing
                  ? "已有安装在跑，同一时间只装一个"
                  : props.busy
                    ? "有别的动作在跑，先等它结束"
                    : `装到 ${props.release.name}；不写 state，也不动正在跑的实例`
            }
            onPress={props.onInstall}
          />
        </View>
      }
    >
      <View style={{ gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, flexWrap: "wrap" }}>
          <Chip tone="info" icon="lucide:download" label={`版本 ${props.release.version}`} />
          <Chip label={props.release.sizeBytes === null ? "官方没给体积" : formatBytes(props.release.sizeBytes)} />
          {exact() === undefined ? null : <Chip tone="success" icon="lucide:check" label={`已装 ${exact()!.name}`} />}
          {exact() === undefined && sameNumber() !== null ? (
            <Chip tone="warning" label={`同版本号 ${sameNumber()!.name}`} />
          ) : null}
        </View>

        {deltaNote(props.release, props.installed)}

        <KeyValueList
          rows={[
            { label: "版本号", value: props.release.version },
            { label: "文件名", value: props.release.filename, mono: true },
            {
              label: "体积",
              value:
                props.release.sizeBytes === null ? "官方没给（按实际下载量算）" : formatBytes(props.release.sizeBytes),
            },
            { label: "检查时间", value: formatRelative(props.release.checkedAt) },
            { label: "来源", value: props.release.url, mono: true },
          ]}
        />

        {props.progress === null ? null : progressRow(props.progress, props.release.name)}
        {props.installError === null ? null : failureNote(props.installError, props.onRetry)}
        {provenanceFold()}
      </View>
    </Card>
  );
}

const [release, setRelease] = createSignal<ReleaseInfo | null>(null);
const [checking, setChecking] = createSignal(false);
const [checkError, setCheckError] = createSignal<unknown>(null);
const [checkedAt, setCheckedAt] = createSignal<string | null>(null);
const [progress, setProgress] = createSignal<InstallProgress | null>(null);
const [installingName, setInstallingName] = createSignal<string | null>(null);
const [installError, setInstallError] = createSignal<unknown>(null);

let controller: AbortController | null = null;
export function ReleasesPage(): SolidChild {
  const store = session();

  const installingNow = (): boolean => installingName() !== null || isInstalling();
  const busyElsewhere = (): boolean => checking() || store.busy() !== null;

  async function check(): Promise<void> {
    if (checking()) return;
    setChecking(true);
    setCheckError(null);
    try {
      const info = await checkRelease();
      setRelease(info);
      setCheckedAt(info.checkedAt);
    } catch (err) {
      // 检查失败不动已拿到的 release：上一次的结论比"什么都没有"更有用。
      setCheckError(err);
      store.notice("warning", failureTitle(err), reason(err));
    } finally {
      setChecking(false);
    }
  }

  async function install(): Promise<void> {
    const info = release();
    if (info === null || installingNow()) return;
    const abort = new AbortController();
    controller = abort;
    setInstallError(null);
    setInstallingName(info.name);
    setProgress({ phase: "downloading", receivedBytes: 0, totalBytes: info.sizeBytes });
    try {
      const installed = await installRelease(info, (next) => setProgress(next), abort.signal);
      store.notice(
        "success",
        `已安装 ${installed.name}`,
        `${formatBytes(installed.sizeBytes)} · 它不会自动成为任何实例的版本；哪个实例用它，在那个实例上选。`,
      );
      store.refreshVersions(false);
    } catch (err) {
      if (err instanceof ReleaseError && err.code === "cancelled") {
        store.notice("info", "已取消安装", "临时文件已经清掉，本机版本没有变化。");
      } else {
        setInstallError(err);
        store.notice("error", failureTitle(err), reason(err));
      }
    } finally {
      controller = null;
      setInstallingName(null);
      setProgress(null);
    }
  }

  // 打开页面就问一次官方：这页存在的意义就是"最新是多少"，不必先让用户点一次按钮。
  void check();

  const installed = store.versions;

  return (
    <PageScroll style={{ gap: space.lg, padding: space.xl }}>
      <PageHeader
        title="服务端版本"
        icon="lucide:download"
        description="官方发布的最新版本，和这台电脑上已经装好的版本。安装只往这里加目录，不动正在跑的服务器。"
        actions={
          <Action
            label="检查更新"
            icon="lucide:refresh-cw"
            tone="info"
            disabled={busyElsewhere() || installingNow()}
            tooltip="再去官方地址问一次最新版本"
            onPress={() => void check()}
          />
        }
      />

      <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>
        {checking()
          ? "正在向官方地址问最新版本…"
          : checkedAt() === null
            ? "还没有检查过官方版本。"
            : `上次检查：${formatRelative(checkedAt()!)}`}
      </Text>

      {checkError() === null ? null : (
        <Note
          tone="danger"
          text={`${failureTitle(checkError())}：${reason(checkError())}`}
          action={<Action label="重试" icon="lucide:refresh-cw" tone="danger" compact onPress={() => void check()} />}
        />
      )}

      {release() === null ? (
        <Card title="官方最新版本" icon="lucide:download" subtitle="问过官方地址才知道有没有新版本">
          {checking() ? (
            <Text style={{ fontSize: fontSize.md, color: palette.textMuted }}>正在问官方地址…</Text>
          ) : (
            <EmptyHint
              icon="lucide:download"
              title="还不知道官方最新是什么版本"
              description="检查一次，或者先看下面已经装好的版本。"
              action={
                <Action
                  label="检查更新"
                  icon="lucide:refresh-cw"
                  tone="info"
                  variant="solid"
                  onPress={() => void check()}
                />
              }
              compact
            />
          )}
        </Card>
      ) : (
        <LatestCard
          release={release()!}
          installed={installed()}
          progress={progress()}
          installError={installError()}
          installing={isInstalling()}
          busy={busyElsewhere()}
          onInstall={() => void install()}
          onCancel={() => controller?.abort()}
          onRetry={() => void install()}
        />
      )}

      <Card
        title="本机已装版本"
        subtitle={
          installed().length === 0
            ? "这台电脑上还没有可用的服务端版本"
            : `${installed().length} 个 · 哪个实例用哪个版本，在实例上选`
        }
        icon="lucide:hard-drive"
        actions={
          <Action
            label="统计占用空间"
            icon="lucide:gauge"
            compact
            disabled={store.busy() !== null || installed().length === 0}
            tooltip="重新扫一遍版本目录并算出占用空间（内容多时要等一会儿）"
            onPress={() => void store.run(SCAN_LABEL, () => store.refreshVersions(true))}
          />
        }
      >
        {installed().length === 0 ? (
          <EmptyHint
            icon="lucide:package"
            title="还没装过服务端"
            description={
              release() === null
                ? "先检查官方最新版本，或者把一个解压好的 r5f-dedi-x.y.z 目录放进面板所在目录。"
                : `点上面「下载并安装」把 ${release()!.name} 装进来。`
            }
            compact
          />
        ) : (
          <View style={{ gap: space.sm }}>{installed().map((version) => installedRow(version))}</View>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, minWidth: 0 }}>
          <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>
            版本目录由 r5apex_ds.exe + server.dll + loader.dll 三件套识别，缺一个就不算可用版本。
          </Text>
          <Help text="这页只负责把版本放进来。启动哪个版本、用哪套配置，由实例自己的设置决定 —— 全局只认一个「当前版本」的做法已经取消。" />
        </View>
      </Card>
    </PageScroll>
  );
}
