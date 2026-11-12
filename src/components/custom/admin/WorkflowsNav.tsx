"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import GitBranch from "lucide-react/icons/git-branch";
import Layers from "lucide-react/icons/layers";
import Plug from "lucide-react/icons/plug";
import Route from "lucide-react/icons/route";
import { cn } from "@/lib/utils";

export const WORKFLOW_SECTIONS = [
  { href: "/admin/workflows/environments", label: "Environments", description: "Promotion order, descriptions and Git branches", icon: Layers },
  { href: "/admin/workflows/connections", label: "Connections", description: "Git repositories, APIs and schema registries", icon: Plug },
  { href: "/admin/workflows/targets", label: "Target routing", description: "Which delivery methods each target may use", icon: Route },
  { href: "/admin/workflows/gitops", label: "GitOps", description: "Git-backed storage and product promotion", icon: GitBranch },
] as const;

/** Section navigation of Admin › Workflows; each section is its own URL so it can be linked and bookmarked. */
export function WorkflowsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Workflow settings" className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {WORKFLOW_SECTIONS.map((s) => {
        const active = pathname.startsWith(s.href);
        const Icon = s.icon;
        return (
          <Link
            key={s.href}
            href={s.href}
            aria-current={active ? "page" : undefined}
            data-testid={`workflows-nav-${s.href.split("/").pop()}`}
            className={cn(
              "flex min-w-0 items-start gap-3 rounded-lg border p-3 transition-colors",
              active ? "border-primary bg-primary/5" : "border-border hover:border-foreground/20 hover:bg-accent/40",
            )}
          >
            <Icon className={cn("mt-0.5 size-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />
            <span className="flex min-w-0 flex-col">
              <span className={cn("text-sm font-medium", active ? "text-foreground" : "text-foreground/90")}>{s.label}</span>
              <span className="text-xs text-muted-foreground">{s.description}</span>
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
