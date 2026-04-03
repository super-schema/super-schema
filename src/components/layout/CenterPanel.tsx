import { Button } from "@/components/ui/button";

interface CenterPanelProps {
  children?: React.ReactNode;
}

export function CenterPanel({ children }: CenterPanelProps) {
  return (
    <main
      data-testid="center-panel"
      className="flex-1 surface-base p-space-6 overflow-auto"
    >
      {children || <EmptyState />}
    </main>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-space-4">
      <h1 className="text-heading-1 text-foreground">
        Create your first entity
      </h1>
      <p className="text-body text-muted-foreground">
        Start defining your data schemas
      </p>
      <Button>New Entity</Button>
    </div>
  );
}
