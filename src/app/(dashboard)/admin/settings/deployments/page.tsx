import { redirect } from "next/navigation";

/** Moved to Admin › Workflows. */
export default function DeploymentSettingsPage() {
  redirect("/admin/workflows/environments");
}
