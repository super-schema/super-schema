import { redirect } from "next/navigation";

export default function WorkflowsIndex() {
  redirect("/admin/workflows/environments");
}
