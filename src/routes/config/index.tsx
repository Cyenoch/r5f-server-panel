import { View } from "@solid-gpui/core";
import { createFileRoute, redirect } from "@solid-gpui/router";

/** Reusable gameplay configuration lives in templates. */
export const Route = createFileRoute("/config/")({
  beforeLoad: () => {
    throw redirect({ to: "/config/modes" });
  },
  component: () => <View />,
});
