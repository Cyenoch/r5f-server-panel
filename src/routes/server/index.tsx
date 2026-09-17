import { View } from "@solid-gpui/core";
import { createFileRoute, redirect } from "@solid-gpui/router";

/** Instances are persistent objects, independent of the current process count. */
export const Route = createFileRoute("/server/")({
  beforeLoad: () => {
    throw redirect({ to: "/server/instances" });
  },
  component: () => <View />,
});
