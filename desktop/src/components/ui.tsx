/**
 * 面板的共用积木：按钮、卡片、指标、键值行、空态、确认框。
 *
 * 只放**跨页面复用**的东西；一个页面只用到一次的排版留在页里。
 * 颜色一律走 `lib/theme`。
 *
 * 两条硬约束（都是实测出来的，别改回去）：
 *  1. 条件与列表只用 `? :` 与 `.map()`，不用 `solid-js` 的 `For`/`Show`
 *     （返回值类型与 `@solid-gpui/core/jsx-runtime` 对不上，自己包一层会把渲染器带进未定义行为）。
 *  2. 按钮自己用 `Pressable` 拼，不用 gpui-component 的 `Button`
 *     —— 后者在本机（Windows + 本 pin 的 vendored gpui）必然栈溢出。
 *     同理不用 `TabBar`/`Tab`；`Sidebar`/`Dialog`/`Table`/`List`/`Select`/`Tooltip`/
 *     `MessageScroller`/`Input`/`Switch`/`Slider`/`Tag`/`Badge`/`Checkbox`/`Empty` 均已实测可用。
 *
 * 控件里的文字必须包 `<Text>`：渲染器规定裸文本只能直接挂在 `Text` 之下。
 */
import { Icon, Pressable, Text, View, type IconName, type SolidChild } from "@solid-gpui/core";
import { Dialog, Scrollable, Separator, Tag } from "@solid-gpui/core/components";
import { createSignal } from "@solid-gpui/core/runtime";
import { font, fontSize, ON_TONE, palette, radius, space } from "../lib/theme";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

const TONE_COLOR: Record<Tone, string> = {
  neutral: palette.textMuted,
  info: palette.info,
  success: palette.success,
  warning: palette.warning,
  danger: palette.danger,
  accent: palette.accent,
};

const TONE_BG: Record<Tone, string> = {
  neutral: palette.panelRaised,
  info: palette.infoSoft,
  success: palette.successSoft,
  warning: palette.warningSoft,
  danger: palette.dangerSoft,
  accent: "#241B3D",
};

/**
 * 实心按钮的 hover 底色：必须仍比正文亮，深色字才压得住。
 * （曾经 hover 直接换成 `TONE_BG` 的柔色底 —— 深字压深底，对比度掉到 1.16，文字等于消失。）
 */
const TONE_HOVER: Record<Tone, string> = {
  neutral: "#A7B2C4",
  info: "#5CCBFB",
  success: "#3ED46F",
  warning: "#F7AE2E",
  danger: "#F68C8C",
  accent: "#B9A3FC",
};

const TAG_VARIANT: Record<Tone, "primary" | "secondary" | "success" | "warning" | "danger" | "info"> = {
  neutral: "secondary",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "danger",
  accent: "primary",
};

export function toneColor(tone: Tone | undefined): string {
  return TONE_COLOR[tone ?? "neutral"];
}

export type ActionVariant = "solid" | "outline" | "ghost";

/**
 * 按钮：`Pressable` + `Icon` + `Text`。
 * `solid` = 实心（主操作）、`outline` = 描边（次操作）、`ghost` = 只有文字（表格里/工具条里）。
 */
export function Action(props: {
  label?: string;
  icon?: IconName;
  onPress: () => void;
  tone?: Tone;
  variant?: ActionVariant;
  compact?: boolean;
  disabled?: boolean;
  tooltip?: string;
}): SolidChild {
  const [hover, setHover] = createSignal(false);
  const tone = props.tone ?? "neutral";
  const variant = props.variant ?? "outline";
  const accent = toneColor(tone);
  const background = () => {
    if (props.disabled) return palette.panelRaised;
    if (variant === "solid") return hover() ? TONE_HOVER[tone] : accent;
    if (variant === "outline") return hover() ? TONE_BG[tone] : palette.panelRaised;
    return hover() ? palette.panelHover : "#00000000";
  };
  const foreground = () =>
    props.disabled ? palette.textDim : variant === "solid" ? palette.primaryForeground : accent;
  const height = props.compact ? 24 : 30;
  return (
    <Pressable
      disabled={props.disabled}
      tooltip={props.tooltip}
      onHoverChange={(value: boolean) => setHover(value)}
      onPress={() => {
        if (!props.disabled) props.onPress();
      }}
      style={{
        height,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: space.xs,
        paddingLeft: props.label ? space.md : space.sm,
        paddingRight: props.label ? space.md : space.sm,
        backgroundColor: background(),
        borderWidth: variant === "ghost" ? 0 : 1,
        borderColor: variant === "solid" ? accent : variant === "outline" ? palette.borderStrong : "#00000000",
        borderRadius: radius.md,
        flexShrink: 0,
      }}
    >
      {props.icon ? <Icon name={props.icon} size={props.compact ? 13 : 15} color={foreground()} /> : null}
      {props.label ? (
        <Text style={{ fontSize: props.compact ? fontSize.sm : fontSize.md, color: foreground() }}>{props.label}</Text>
      ) : null}
    </Pressable>
  );
}

/** 状态点 + 文案：一眼看出运行/停止/告警。 */
export function StatusDot(props: { tone: Tone; label: string }): SolidChild {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: TONE_COLOR[props.tone] }} />
      <Text style={{ color: TONE_COLOR[props.tone], fontSize: fontSize.md }}>{props.label}</Text>
    </View>
  );
}

export function Chip(props: { tone?: Tone; label: string; icon?: IconName }): SolidChild {
  const tone = props.tone ?? "neutral";
  // Tag 是实心底：文字必须用该底色的前景色，不能再用同色系的"语义色"（那样会看不见）。
  return (
    <Tag variant={TAG_VARIANT[tone]} size="small">
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        {props.icon ? <Icon name={props.icon} size={12} color={ON_TONE[tone]} /> : null}
        <Text style={{ color: ON_TONE[tone], fontSize: fontSize.sm }}>{props.label}</Text>
      </View>
    </Tag>
  );
}

/** 卡片：标题行（图标 + 标题 + 右侧动作）+ 内容。 */
export function Card(props: {
  title?: string;
  subtitle?: string;
  icon?: IconName;
  tone?: Tone;
  actions?: SolidChild;
  padding?: number;
  grow?: boolean;
  gap?: number;
  children: SolidChild;
}): SolidChild {
  return (
    <View
      style={{
        padding: props.padding ?? space.lg,
        gap: props.gap ?? space.md,
        backgroundColor: palette.panel,
        borderWidth: 1,
        borderColor: palette.borderSoft,
        borderRadius: radius.lg,
        flexGrow: props.grow ? 1 : 0,
        flexShrink: 1,
        minHeight: 0,
        minWidth: 0,
      }}
    >
      {props.title ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 0 }}>
          {props.icon ? <Icon name={props.icon} size={16} color={toneColor(props.tone ?? "info")} /> : null}
          <View style={{ flexGrow: 1, minWidth: 0 }}>
            <Text style={{ fontSize: fontSize.lg, fontWeight: "semibold", color: palette.text }}>{props.title}</Text>
            {props.subtitle ? (
              <Text style={{ fontSize: fontSize.sm, color: palette.textDim }}>{props.subtitle}</Text>
            ) : null}
          </View>
          {props.actions ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>{props.actions}</View>
          ) : null}
        </View>
      ) : null}
      {props.children}
    </View>
  );
}

/** 指标块：图标 + 数值 + 单位 + 说明，`tone` 决定强调色。 */
export function Stat(props: {
  label: string;
  value: string;
  unit?: string;
  icon?: IconName;
  tone?: Tone;
  hint?: string;
}): SolidChild {
  const color = toneColor(props.tone);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        padding: space.md,
        backgroundColor: palette.panelRaised,
        borderRadius: radius.md,
        minWidth: 176,
        flexGrow: 1,
        flexShrink: 1,
      }}
    >
      {props.icon ? (
        <View style={{ padding: space.sm, backgroundColor: TONE_BG[props.tone ?? "neutral"], borderRadius: radius.md }}>
          <Icon name={props.icon} size={18} color={color} />
        </View>
      ) : null}
      <View style={{ gap: 2, minWidth: 0 }}>
        <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>{props.label}</Text>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.xs }}>
          <Text style={{ fontSize: fontSize.xl, fontWeight: "semibold", color: palette.text }}>{props.value}</Text>
          {props.unit ? <Text style={{ fontSize: fontSize.sm, color: palette.textMuted }}>{props.unit}</Text> : null}
        </View>
        {props.hint ? <Text style={{ fontSize: fontSize.xs, color: palette.textDim }}>{props.hint}</Text> : null}
      </View>
    </View>
  );
}

export type KeyValueRow = { label: string; value: string; tone?: Tone; mono?: boolean };

/** 键值行：左标签右值，值可指定色调。 */
export function KeyValue(props: KeyValueRow): SolidChild {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md, minWidth: 0 }}>
      <Text style={{ width: 108, fontSize: fontSize.sm, color: palette.textDim, flexShrink: 0 }}>{props.label}</Text>
      <Text
        style={{
          flexGrow: 1,
          minWidth: 0,
          fontSize: fontSize.md,
          color: props.tone ? toneColor(props.tone) : palette.text,
          fontFamily: props.mono ? font.mono : undefined,
        }}
      >
        {props.value}
      </Text>
    </View>
  );
}

/** 一列键值 + 分隔线。 */
export function KeyValueList(props: { rows: KeyValueRow[] }): SolidChild {
  return (
    <View style={{ gap: space.sm }}>
      {props.rows.map((row, index) => (
        <View style={{ gap: space.sm }}>
          {index > 0 ? <Separator /> : null}
          <KeyValue label={row.label} value={row.value} tone={row.tone} mono={row.mono} />
        </View>
      ))}
    </View>
  );
}

/** 空态：图标 + 标题 + 说明 + 可选动作。 */
export function EmptyHint(props: {
  icon?: IconName;
  title: string;
  description?: string;
  action?: SolidChild;
  compact?: boolean;
}): SolidChild {
  return (
    <View
      style={{
        alignItems: "center",
        justifyContent: "center",
        gap: space.sm,
        padding: props.compact ? space.lg : space.xxl,
        flexGrow: 1,
        minHeight: 0,
      }}
    >
      {props.icon ? <Icon name={props.icon} size={props.compact ? 22 : 34} color={palette.textDim} /> : null}
      <Text style={{ fontSize: fontSize.lg, color: palette.textMuted }}>{props.title}</Text>
      {props.description ? (
        <Text style={{ fontSize: fontSize.sm, color: palette.textDim, textAlign: "center" }}>{props.description}</Text>
      ) : null}
      {props.action ? <View style={{ marginTop: space.sm }}>{props.action}</View> : null}
    </View>
  );
}

/** 页面标题区：标题 + 说明 + 右侧动作，所有页面第一屏都是它。 */
export function PageHeader(props: {
  title: string;
  description?: string;
  icon?: IconName;
  actions?: SolidChild;
}): SolidChild {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md, minWidth: 0 }}>
      {props.icon ? (
        <View style={{ paddingTop: 2 }}>
          <Icon name={props.icon} size={22} color={palette.primary} />
        </View>
      ) : null}
      <View style={{ flexGrow: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ fontSize: fontSize.xxl, fontWeight: "semibold", color: palette.text }}>{props.title}</Text>
        {props.description ? (
          <Text style={{ fontSize: fontSize.md, color: palette.textMuted }}>{props.description}</Text>
        ) : null}
      </View>
      {props.actions ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>{props.actions}</View>
      ) : null}
    </View>
  );
}

function defaultNoteIcon(tone: Tone): IconName {
  if (tone === "danger" || tone === "warning") return "lucide:triangle-alert";
  if (tone === "success") return "lucide:check";
  return "lucide:info";
}

/** 只读提示条：说明、警告、下一步都走它，避免每个页面自造配色。 */
export function Note(props: { tone?: Tone; icon?: IconName; text: string; action?: SolidChild }): SolidChild {
  const tone = props.tone ?? "info";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        padding: space.md,
        backgroundColor: TONE_BG[tone],
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: TONE_COLOR[tone],
      }}
    >
      <Icon name={props.icon ?? defaultNoteIcon(tone)} size={16} color={TONE_COLOR[tone]} />
      <Text style={{ flexGrow: 1, minWidth: 0, fontSize: fontSize.sm, color: palette.text }}>{props.text}</Text>
      {props.action ?? null}
    </View>
  );
}

/** 确认对话框：危险动作（停止/封禁/删除档案）统一用它。 */
export function Confirm(props: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): SolidChild {
  return (
    <Dialog
      open={props.open}
      title={props.title}
      width={440}
      buttons={{
        okText: props.confirmLabel ?? "确认",
        cancelText: props.cancelLabel ?? "取消",
        okVariant: props.danger ? "danger" : "primary",
        showCancel: true,
      }}
      onAction={(action) => {
        if (action.kind === "ok") props.onConfirm();
        else props.onCancel();
      }}
    >
      <Text style={{ fontSize: fontSize.md, color: palette.textMuted }}>{props.message}</Text>
    </Dialog>
  );
}

/** 横向工具条：一排按钮，自动折行。 */
export function Toolbar(props: { children: SolidChild; gap?: number }): SolidChild {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: props.gap ?? space.sm, flexWrap: "wrap" }}>
      {props.children}
    </View>
  );
}

/** 区块小标题（卡片内部的第二层）。 */
export function SectionTitle(props: { text: string; icon?: IconName; actions?: SolidChild }): SolidChild {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      {props.icon ? <Icon name={props.icon} size={14} color={palette.textMuted} /> : null}
      <Text style={{ fontSize: fontSize.sm, fontWeight: "semibold", color: palette.textMuted }}>{props.text}</Text>
      <View style={{ flexGrow: 1, minWidth: 0 }} />
      {props.actions ?? null}
    </View>
  );
}

/**
 * 长页面外壳：占满内容区、纵向可滚、右侧有滚动条。
 *
 * 为什么不让页面自己在根 View 上写 `overflow: "scroll"`：根节点同时带 `flexGrow: 1` 时，
 * 它会**正好被撑到视口高度**，内容超出后只是被裁掉 —— 滚动条不出现、滚轮也不动，
 * 底部的卡片用户永远够不到（本机实测：设置页第 4 行以下全部不可达）。
 * 这里改成外层滚动、内层自然高度（`flexShrink: 0`），内容多高就多高，滚动范围才是真的。
 *
 * 用法：页面根元素直接换成 `<PageScroll style={{...原来的样式...}}>`，
 * 样式里的 `flexGrow`/`overflow` 会被忽略（由这里接管），`gap`/`padding` 照旧生效。
 */
export function PageScroll(props: { children?: SolidChild; style?: Record<string, unknown> }): SolidChild {
  const base = props.style ?? {};
  return (
    <Scrollable
      style={{
        flexGrow: 1,
        height: 0,
        minHeight: 0,
        minWidth: 0,
        flexDirection: "column",
      }}
    >
      <View
        style={{
          ...base,
          flexGrow: undefined,
          overflow: undefined,
          height: undefined,
          flexShrink: 0,
          minWidth: 0,
          flexDirection: "column",
        }}
      >
        {props.children}
      </View>
    </Scrollable>
  );
}
