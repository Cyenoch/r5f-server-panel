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
  /** 徽标的两种来源：运行实例数、在线玩家数 */
  badge?: "instances" | "players";
};

export type NavGroup = { key: string; label: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    key: "workspace",
    label: "工作区",
    items: [
      { to: "/", label: "总览", icon: "lucide:gauge" },
      { to: "/server/instances", label: "服务器实例", icon: "lucide:layers" },
      { to: "/server/running", label: "运行中", icon: "lucide:cpu", badge: "instances" },
    ],
  },
  {
    key: "resources",
    label: "可复用资源",
    items: [
      { to: "/config/modes", label: "游戏模式模板", icon: "lucide:puzzle" },
      { to: "/server/list", label: "服务端版本", icon: "lucide:download" },
    ],
  },
  {
    key: "host",
    label: "主机",
    items: [
      { to: "/config/host", label: "主机环境", icon: "lucide:hard-drive" },
      { to: "/setup", label: "开服检查清单", icon: "lucide:check-square" },
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
