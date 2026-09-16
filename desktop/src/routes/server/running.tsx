import { createFileRoute } from "@solid-gpui/router";
import { InstancesPage } from "../../components/instances";
export const Route = createFileRoute("/server/running")({ component: () => <InstancesPage runningOnly /> });
