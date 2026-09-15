import * as api from "@server/panel";
import { View } from "@solid-gpui/core";
import { createFileRoute, redirect } from "@solid-gpui/router";

/**
 * 「服务器」段没有自己的页面：进来时按当前有几个实例决定去哪。
 *  - 没有实例 → 服务器列表（去挑一个启动）
 *  - 一个实例 → 实时日志（单实例时日志就是主界面）
 *  - 多个实例 → 实例列表（先选一个再进日志）
 */
export const Route = createFileRoute("/server/")({
  beforeLoad: async () => {
    const running = await api.collectDediProcesses();
    if (running.length === 0) throw redirect({ to: "/server/list" });
    if (running.length === 1) throw redirect({ to: "/server/logs" });
    throw redirect({ to: "/server/instances" });
  },
  component: () => <View />,
});
