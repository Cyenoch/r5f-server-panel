/**
 * 左侧导航模型：路由、图标、文案、分组只在这里声明一次。
 * 侧栏、面包屑、状态栏都从这里取，避免三处各写一套。
 */
import type { IconName } from "@solid-gpui/core";
import type { FileRoutesByFullPath } from "../routeTree.gen";

/**
 * 路由字面量：从生成的路由树取，导航项写错路径在类型检查阶段就会报出来。
 * 末尾带 `/` 的两个是索引路由（`/server/`、`/config/`），只用来做重定向，不进导航；
 * TanStack 把它们的可导航形式写成 `/server`、`/config`，与这里的键不同名，所以排除掉。
 */
export type RoutePath = Exclude<keyof FileRoutesByFullPath, "/server/" | "/config/">;

export type NavItem = {
  /** 路由全路径 */
  to: RoutePath;
  label: string;
  icon: IconName;
  /** 状态栏/面包屑用的一句话说明 */
  hint: string;
  /** 徽标的两种来源：运行实例数、在线玩家数 */
  badge?: "instances" | "players";
};

export type NavGroup = { key: string; label: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    key: "overview",
    label: "总览",
    items: [{ to: "/", label: "首页", icon: "lucide:gauge", hint: "服务器数据面板", badge: "instances" }],
  },
  {
    key: "server",
    label: "服务器",
    items: [
      { to: "/server/list", label: "服务器列表", icon: "lucide:layers", hint: "本机所有服务端版本" },
      { to: "/server/instances", label: "实例", icon: "lucide:cpu", hint: "运行中的进程", badge: "instances" },
      { to: "/server/logs", label: "实时日志", icon: "lucide:list", hint: "引擎输出与控制台" },
      { to: "/server/players", label: "玩家列表", icon: "lucide:users", hint: "在线玩家与审核", badge: "players" },
      { to: "/server/control", label: "控制面板", icon: "lucide:sliders-horizontal", hint: "运行期可视化调整" },
    ],
  },
  {
    key: "config",
    label: "配置文件",
    items: [
      { to: "/config/server", label: "服务器配置", icon: "lucide:settings", hint: "启动配置档案" },
      { to: "/config/modes", label: "模式与地图", icon: "lucide:puzzle", hint: "玩法目录与热切换" },
      { to: "/config/announcements", label: "公告", icon: "lucide:bell", hint: "轮播与进场文案" },
      { to: "/config/host", label: "主机配置", icon: "lucide:hard-drive", hint: "防火墙/页面文件/自启" },
    ],
  },
  {
    key: "ops",
    label: "运维",
    items: [
      { to: "/ops/health", label: "体检", icon: "lucide:heart", hint: "主机与本次运行健康" },
      { to: "/ops/banlist", label: "封禁名单", icon: "lucide:box", hint: "引擎名单与本机台账" },
      { to: "/setup", label: "启动引导", icon: "lucide:rocket", hint: "首次使用的分步设置" },
    ],
  },
];

const ALL_ITEMS: NavItem[] = NAV.flatMap((group) => group.items);

/** 当前路径对应的导航项；子路由（`/server/logs?run=x` 之类）按前缀归到最长的那个。 */
export function navItemFor(pathname: string): NavItem | null {
  let best: NavItem | null = null;
  for (const item of ALL_ITEMS) {
    if (item.to === pathname) return item;
    if (item.to !== "/" && pathname.startsWith(`${item.to}/`)) {
      if (!best || item.to.length > best.to.length) best = item;
    }
  }
  return best;
}

export function navGroupFor(item: NavItem | null): NavGroup | null {
  if (!item) return null;
  return NAV.find((group) => group.items.includes(item)) ?? null;
}

/** 首次引导没走完之前，状态栏一直提示（判断条件在 `needsOnboarding` 里）。 */
export function needsOnboarding(criteria: {
  hasVersion: boolean;
  hostipSet: boolean;
  firewallConfigured: boolean;
}): boolean {
  return !criteria.hasVersion || !criteria.hostipSet || !criteria.firewallConfigured;
}

export type OnboardingStep = {
  key: string;
  title: string;
  description: string;
  done: boolean;
};

/** 引导页的步骤清单：给首页与状态栏共用，进度只算一次。 */
export function onboardingSteps(criteria: {
  hasVersion: boolean;
  hostnameSet: boolean;
  hostipSet: boolean;
  firewallConfigured: boolean;
}): OnboardingStep[] {
  return [
    {
      key: "version",
      title: "放入服务端",
      description: "把解压好的服务端文件夹放进面板所在目录。",
      done: criteria.hasVersion,
    },
    {
      key: "name",
      title: "起个服务器名字",
      description: "玩家在服务器列表里看到的就是这个名字。",
      done: criteria.hostnameSet,
    },
    {
      key: "address",
      title: "填公网地址",
      description: "云主机和家里路由器后面都要填，否则别人在列表里搜不到你。",
      done: criteria.hostipSet,
    },
    {
      key: "ports",
      title: "放行端口",
      description: "Windows 防火墙和云主机的安全组都要放行，两边是两套规则。",
      done: criteria.firewallConfigured,
    },
  ];
}
