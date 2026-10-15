import Link from "next/link";
import { ChevronRight } from "lucide-react";

export interface Crumb {
  label: string;
  href?: string;
}

export function EventBreadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-space-4 flex flex-wrap items-center gap-space-1 text-body-small text-muted-foreground">
      {crumbs.map((c, i) => (
        <span key={`${c.label}-${i}`} className="flex items-center gap-space-1">
          {i > 0 && <ChevronRight className="w-3 h-3" aria-hidden="true" />}
          {c.href ? (
            <Link href={c.href} className="hover:text-foreground transition-colors">{c.label}</Link>
          ) : (
            <span className="font-medium text-foreground">{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
