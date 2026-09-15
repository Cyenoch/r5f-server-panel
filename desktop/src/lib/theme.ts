/**
 * 面板配色与排版：一处声明，`setApplicationTheme`（Kit 控件）与 Solid 样式共用同一组值。
 *
 * 深色是唯一主题 —— 这台机器的面板常年挂在服务器上，浅色刺眼且没必要；
 * `setTheme("dark")` 仍然要调，否则 Kit 控件会按系统外观走。
 */
import type { ApplicationTheme } from "@solid-gpui/core/components";

/** 语义色板：界面里出现的每个颜色都从这里取，不在页面里写死十六进制。
 *
 * 亮度是按 WCAG 对比度选过的（正文 ≥ 4.5:1，深底上的次要文字也要过）：
 * `textDim` 5.1（面板底）、`danger` 5.4（描边/文字）· 6.3（深字压红底）、
 * `logDim` 5.6（日志底）。改色前先算一遍对比度，别退回低于 4.5 的值。 */
export const palette = {
  bg: "#0D1117",
  sidebar: "#111721",
  panel: "#161C26",
  panelRaised: "#1B2230",
  panelHover: "#1F2836",
  border: "#242E3C",
  borderSoft: "#1B222E",
  /** 可交互控件的描边：比普通分隔线亮一档，让按钮"看得出是按钮"。 */
  borderStrong: "#334054",

  text: "#E6EAF2",
  textMuted: "#93A0B4",
  textDim: "#828E9F",

  primary: "#3B82F6",
  primaryHover: "#60A5FA",
  primaryForeground: "#0B1220",

  success: "#22C55E",
  successSoft: "#123122",
  warning: "#F59E0B",
  warningSoft: "#33260A",
  danger: "#F26B6B",
  dangerSoft: "#3A1517",
  info: "#38BDF8",
  infoSoft: "#0C2A3A",
  accent: "#A78BFA",

  /** 日志区专用：比面板更暗，长盯不累。 */
  log: "#080B10",
  logLine: "#C6D0DE",
  logDim: "#7E8A9B",
  logError: "#F87171",
  logWarn: "#FBBF24",
  logOk: "#4ADE80",
} as const;

/**
 * 语义底上的前景色：给「实心底 + 文字」的控件用（Kit 的 Tag、Badge、实心按钮）。
 * 用同色系写文字会直接看不见（本机踩过：青底 + 青字 = 空药丸），所以这里与
 * `panelTheme` 的 `*Foreground` 同源，改一处两边一起变。
 */
export const ON_TONE = {
  neutral: "#E6EAF2",
  info: "#04141D",
  success: "#06210F",
  warning: "#241703",
  danger: "#1A0A0B",
  accent: "#0B1220",
} as const;

/** 圆角与间距：所有页面用同一组，避免每个页面自己定一套。 */
export const radius = { sm: 4, md: 8, lg: 12 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const fontSize = { xs: 11, sm: 12, md: 13, lg: 15, xl: 20, xxl: 28 } as const;

/**
 * 字体：正文交给系统默认（中文回落到系统的中文字体），日志用等宽 ——
 * 引擎日志按列对齐，等宽才能一眼读出时间戳与级别。
 */
export const font = { mono: "Cascadia Mono, Consolas, monospace" } as const;

/** 卡片：面板里最常用的容器，直接用同一份样式对象。 */
export const cardStyle = {
  padding: space.lg,
  gap: space.sm,
  backgroundColor: palette.panel,
  borderWidth: 1,
  borderColor: palette.borderSoft,
  borderRadius: radius.lg,
} as const;

export const panelTheme: ApplicationTheme = {
  colors: {
    background: palette.bg,
    foreground: palette.text,
    border: palette.border,
    sidebar: palette.sidebar,
    sidebarForeground: palette.textMuted,
    sidebarBorder: palette.borderSoft,
    sidebarPrimary: palette.primary,
    sidebarPrimaryForeground: palette.text,
    sidebarAccent: palette.panelHover,
    sidebarAccentForeground: palette.text,
    input: palette.panelRaised,
    popover: palette.panelRaised,
    popoverForeground: palette.text,
    muted: palette.panelRaised,
    mutedForeground: palette.textMuted,
    primary: palette.primary,
    primaryHover: palette.primaryHover,
    primaryActive: palette.primaryHover,
    primaryForeground: palette.primaryForeground,
    buttonPrimary: palette.primary,
    buttonPrimaryHover: palette.primaryHover,
    buttonPrimaryActive: palette.primaryHover,
    buttonPrimaryForeground: palette.primaryForeground,
    button: palette.panelRaised,
    buttonHover: palette.panelHover,
    buttonActive: palette.panelHover,
    buttonForeground: palette.text,
    buttonSecondary: palette.panelRaised,
    buttonSecondaryHover: palette.panelHover,
    buttonSecondaryForeground: palette.text,
    buttonDanger: palette.danger,
    buttonDangerHover: "#F87171",
    buttonDangerForeground: ON_TONE.danger,
    danger: palette.danger,
    dangerForeground: ON_TONE.danger,
    success: palette.success,
    successForeground: ON_TONE.success,
    warning: palette.warning,
    warningForeground: ON_TONE.warning,
    info: palette.info,
    infoForeground: ON_TONE.info,
    ring: palette.primary,
    accent: palette.accent,
    link: palette.primary,
    linkHover: palette.primaryHover,
    selection: "#1D3A63",
    scrollbar: palette.panel,
    scrollbarThumb: palette.border,
    scrollbarThumbHover: "#33405A",
    titleBar: palette.sidebar,
    titleBarBorder: palette.borderSoft,
    statusBar: palette.sidebar,
    statusBarBorder: palette.borderSoft,
    table: palette.panel,
    tableHead: palette.panelRaised,
    tableHeadForeground: palette.textMuted,
    tableEven: palette.panel,
    tableHover: palette.panelHover,
    tableActive: "#17304F",
    tableActiveBorder: palette.primary,
    tableRowBorder: palette.borderSoft,
    list: palette.panel,
    listHover: palette.panelHover,
    listActive: "#17304F",
    listActiveBorder: palette.primary,
    listHead: palette.panelRaised,
    tabBar: "transparent",
    tab: "transparent",
    tabActive: palette.panelRaised,
    tabForeground: palette.textMuted,
    tabActiveForeground: palette.text,
    switch: palette.primary,
    switchThumb: palette.text,
    sliderBar: palette.border,
    sliderThumb: palette.primary,
    progressBar: palette.primary,
    overlay: "#05080CCC",
    windowBorder: palette.border,
  },
  radius: radius.md,
  radiusLg: radius.lg,
  fontSize: fontSize.md,
  lineHeight: 20,
  components: {
    button: { height: 30, fontSize: fontSize.md, lineHeight: 19, paddingX: 12, radius: radius.md },
    input: { height: 30, fontSize: fontSize.md, lineHeight: 19, paddingX: 10, radius: radius.md },
    select: { height: 30, fontSize: fontSize.md, lineHeight: 19, paddingX: 10, radius: radius.md },
    menu: { height: 28, fontSize: fontSize.md, lineHeight: 19 },
    tag: { height: 20, fontSize: fontSize.sm, lineHeight: 16, paddingX: 8, radius: radius.sm },
  },
};

/** 日志行按内容给个色调：排障时一眼能挑出错误，不必逐行读。 */
export function logTone(line: string): string {
  if (/\b(error|failed|failure|fatal|crash|assert)\b/i.test(line)) return palette.logError;
  if (/\b(warn|warning|deprecat|retry|timeout)\b/i.test(line)) return palette.logWarn;
  if (/^(Kicked |Ban|Installed NetKey|Starting server)/i.test(line)) return palette.logOk;
  return palette.logLine;
}
