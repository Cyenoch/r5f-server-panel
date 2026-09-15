import { View } from "@solid-gpui/core";
import { createFileRoute, redirect } from "@solid-gpui/router";

/**
 * `/config/` 是「配置文件」段的索引，没有自己的页面：进来直接去服务器配置。
 * 与 `/server/` 一样只做重定向，`component` 永远不会被渲染。
 */
export const Route = createFileRoute("/config/")({
  beforeLoad: () => {
    throw redirect({ to: "/config/server" });
  },
  component: () => <View />,
});
