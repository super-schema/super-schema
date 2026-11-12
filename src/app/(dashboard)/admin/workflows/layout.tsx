import { WorkflowsNav } from "@/components/custom/admin/WorkflowsNav";

/** Admin › Workflows: how schemas reach their destinations — environments, connections, target routing and GitOps. */
export default function WorkflowsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-space-4">
      <div>
        <h2 className="text-heading-3 text-foreground">Workflows</h2>
        <p className="text-body-small text-muted-foreground">How schemas move from authoring to their destinations in the active tenant.</p>
      </div>
      <WorkflowsNav />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
