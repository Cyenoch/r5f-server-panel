import type { HostFacts } from "@server/inspect";
/**
 * 体检：只回答两个问题 —— 这次运行出过错吗？这台机器还差什么？
 *
 * 版式约定（UI 重做后）：**结论优先，细节不在这儿重抄一遍**。
 * 主机的事实（内存/磁盘/换页/自启/端口/防火墙的逐项状态）只在「主机配置」页展示，
 * 这里只列"没生效的那几项"和一个跳转 —— 同一批数据两页各写一份，只会让人对不上口径。
 *
 * 口径只有一条：没读到就说没读到，`error.log` 非空就不能说健康。
 */
import { Text, View, type SolidChild } from "@solid-gpui/core";
import { createFileRoute, useNavigate } from "@solid-gpui/router";
import {
  Action,
  Card,
  Chip,
  EmptyHint,
  Fold,
  Help,
  IconAction,
  KeyValueList,
  Note,
  PageHeader,
  PageScroll,
} from "../../components/ui";
import { formatBytes, shortId } from "../../lib/format";
import { session } from "../../lib/session";
import { font, fontSize, palette, radius, space } from "../../lib/theme";

export const Route = createFileRoute("/ops/health")({ component: Page });

/** error.log 最多摆这么多行：它的头部就够定位，全文去实时日志页看。 */
const ERROR_LINES = 12;

/** 还差哪些系统设置：只报名字，细节在主机配置页。 */
function missingItems(facts: HostFacts): string[] {
  const items: string[] = [];
  if (facts.firewallMissing.length > 0) items.push("放行游戏端口");
  if (facts.pageInitMB === 0) items.push("固定页面文件大小");
  if (!facts.defenderExcluded) items.push("排除杀毒软件扫描目录");
  if (facts.taskState.length === 0) items.push("开机自启");
  if (!facts.powerHighPerformance) items.push("高性能电源计划");
  return items;
}

/** 本次运行：先说结论，出错才摊开记录。 */
function RunCard(): SolidChild {
  const store = session();
  const navigate = useNavigate();
  const health = store.health;
  const error = () => health()?.error ?? null;
  const bytes = () => error()?.bytes ?? 0;
  const runId = () => health()?.runId ?? "";
  const failed = () => error() !== null && error()!.exists && bytes() > 0;

  return (
    <Card
      title="本次运行"
      icon="lucide:heart"
      tone={error() === null ? "neutral" : !error()!.exists ? "warning" : bytes() > 0 ? "danger" : "success"}
      subtitle="这台服务器最近一次运行"
      actions={
        <Action
          label="看日志"
          icon="lucide:list"
          variant="ghost"
          compact
          onPress={() => void navigate({ to: "/server/logs" })}
        />
      }
    >
      {health() === null ? (
        <EmptyHint
          compact
          icon="lucide:refresh-cw"
          title="还没读到运行记录"
          description="每 30 秒自动刷一次；也可以点右上角重新检查。"
        />
      ) : !error()!.exists ? (
        <Text style={{ fontSize: fontSize.md, color: palette.textMuted }}>
          {store.versions().length === 0
            ? "一个可用的服务端版本都没有 —— 先去「启动引导」放一份。"
            : "没找到这台服务器留下的错误记录，可能它还没启动过。"}
        </Text>
      ) : failed() ? (
        <View style={{ gap: space.sm, minWidth: 0 }}>
          <Chip tone="danger" icon="lucide:triangle-alert" label={`记录到错误 · ${formatBytes(bytes())}`} />
          <View
            style={{
              backgroundColor: palette.log,
              borderRadius: radius.md,
              padding: space.md,
              gap: 2,
              minWidth: 0,
            }}
          >
            {error()!.lines.length === 0 ? (
              <Text style={{ fontFamily: font.mono, fontSize: fontSize.sm, color: palette.logDim }}>
                记录里有内容，但读不出能看的文字。
              </Text>
            ) : (
              error()!
                .lines.slice(0, ERROR_LINES)
                .map((line) => (
                  <Text style={{ fontFamily: font.mono, fontSize: fontSize.sm, color: palette.logError }}>{line}</Text>
                ))
            )}
          </View>
        </View>
      ) : (
        <Chip tone="success" icon="lucide:check" label="没有记录到错误" />
      )}

      {health() === null ? null : (
        <Fold label="运行编号与启动提示">
          <View style={{ gap: space.sm, minWidth: 0 }}>
            <KeyValueList
              rows={[
                {
                  label: "运行编号",
                  value: runId().length > 0 ? shortId(runId()) : "没读到",
                  tone: runId().length > 0 ? undefined : "warning",
                  mono: true,
                },
                {
                  label: "启动提示",
                  value: health()!.warning.exists
                    ? `${health()!.warning.lines.length} 行（启动自检输出，不是错误）`
                    : "没有",
                },
                {
                  label: "脚本提示",
                  value: health()!.scriptWarning.exists
                    ? `${health()!.scriptWarning.lines.length} 行（脚本自己的提醒，不影响启动）`
                    : "没有",
                },
              ]}
            />
            <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>
              运行编号截前 8 位，报障时把它一并发出去就能对上同一次运行。
            </Text>
          </View>
        </Fold>
      )}
    </Card>
  );
}

/** 这台机器：只列没生效的项 + 端口占用，细节去主机配置页。 */
function MachineCard(): SolidChild {
  const store = session();
  const navigate = useNavigate();
  const host = store.host;
  const capabilities = store.capabilities;
  const port = () => store.settings().port;
  const pending = () => capabilities().filter((item) => !item.enabled);
  const missingNames = () => (host() === null ? [] : missingItems(host()!));

  return (
    <Card
      title="这台机器"
      icon="lucide:hard-drive"
      tone={missingNames().length === 0 && !host()?.portInUse ? "success" : "warning"}
      subtitle="系统侧还差什么"
      actions={
        <Action
          label="去主机配置"
          icon="lucide:arrow-left"
          variant="ghost"
          compact
          onPress={() => void navigate({ to: "/config/host" })}
        />
      }
    >
      {host() === null || capabilities().length === 0 ? (
        <EmptyHint
          compact
          icon="lucide:refresh-cw"
          title="还没读到这台机器的信息"
          description="最多等 30 秒；也可以点右上角重新检查。"
        />
      ) : (
        <View style={{ gap: space.sm, minWidth: 0 }}>
          {host()!.portInUse ? (
            <Note
              tone="danger"
              text={`UDP ${port()} 被别的程序占用了 —— 服务器会启动失败，先换端口或关掉占用它的程序。`}
            />
          ) : null}
          {missingNames().length === 0 ? (
            <Chip tone="success" icon="lucide:check" label="系统侧的设置都到位了" />
          ) : (
            <View style={{ gap: space.xs, minWidth: 0 }}>
              {pending().map((capability) => (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.sm,
                    paddingTop: space.xs,
                    paddingBottom: space.xs,
                    minWidth: 0,
                  }}
                >
                  <Chip tone="warning" icon="lucide:x" label="未生效" />
                  <Text style={{ fontSize: fontSize.md, color: palette.text }}>{capability.label}</Text>
                  <Help text={capability.detail} />
                </View>
              ))}
            </View>
          )}
        </View>
      )}
    </Card>
  );
}

function Page(): SolidChild {
  const store = session();
  return (
    <PageScroll style={{ gap: space.lg, padding: space.xl }}>
      <PageHeader
        title="体检"
        icon="lucide:heart"
        description="跑不起来、玩家连不上、换图卡，先看这一页。"
        actions={
          <IconAction
            icon="lucide:refresh-cw"
            label="重新检查这台机器与本次运行"
            disabled={store.busy() !== null}
            onPress={() => void store.refreshSlow(true)}
          />
        }
      />
      <RunCard />
      <MachineCard />
    </PageScroll>
  );
}
