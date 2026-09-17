import { createFileRoute } from "@solid-gpui/router";
import { ReleasesPage } from "../../components/releases";
export const Route = createFileRoute("/server/list")({ component: ReleasesPage });
