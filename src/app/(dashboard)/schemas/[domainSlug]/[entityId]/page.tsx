import { prisma } from "@/lib/db";
import { fromSlug } from "@/lib/domain-utils";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface Props {
  params: Promise<{ domainSlug: string; entityId: string }>;
}

export default async function EntityDetailPage({ params }: Props) {
  const { domainSlug, entityId } = await params;
  const domainName = fromSlug(domainSlug);

  const entity = await prisma.entity.findUnique({
    where: { id: entityId },
    include: {
      domain: true,
      fields: { orderBy: { sortOrder: "asc" } },
    },
  });

  if (!entity) {
    notFound();
  }

  const statusColor =
    entity.status === "ACTIVE"
      ? "bg-success"
      : entity.status === "DRAFT"
        ? "bg-warning"
        : "bg-muted-foreground";

  return (
    <div className="animate-auth-fade-up">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-space-1 text-body-small text-muted-foreground mb-space-4">
        <Link href="/schemas" className="hover:text-foreground transition-colors">
          Domains
        </Link>
        <ChevronRight className="w-3 h-3" />
        <Link
          href={`/schemas/${domainSlug}`}
          className="hover:text-foreground transition-colors"
        >
          {entity.domain.name}
        </Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-foreground font-medium font-mono">{entity.name}</span>
      </nav>

      {/* Header */}
      <div className="flex items-center justify-between mb-space-6">
        <div className="flex items-center gap-space-3">
          <h1 className="text-display text-foreground font-mono">{entity.name}</h1>
          <span className={`w-2.5 h-2.5 rounded-full ${statusColor}`} />
          <Badge variant="outline">{entity.status}</Badge>
          <Badge variant="secondary">v{entity.version}</Badge>
        </div>
      </div>

      {entity.description && (
        <p className="text-body text-muted-foreground mb-space-6">{entity.description}</p>
      )}

      {/* Fields table */}
      <div className="mb-space-8">
        <h2 className="text-heading-2 text-foreground mb-space-4">
          Fields ({entity.fields.length})
        </h2>
        {entity.fields.length === 0 ? (
          <div className="surface-glass rounded-xl border border-border p-space-8 text-center">
            <p className="text-body text-muted-foreground">
              No fields yet — add your first field to define this entity&apos;s structure
            </p>
          </div>
        ) : (
          <div className="surface-glass rounded-xl border border-border overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-caption text-muted-foreground">
                  <th className="text-left px-space-4 py-space-3 font-medium">#</th>
                  <th className="text-left px-space-4 py-space-3 font-medium">Name</th>
                  <th className="text-left px-space-4 py-space-3 font-medium">Type</th>
                  <th className="text-left px-space-4 py-space-3 font-medium">Nullable</th>
                  <th className="text-left px-space-4 py-space-3 font-medium">Key</th>
                  <th className="text-left px-space-4 py-space-3 font-medium">Classification</th>
                </tr>
              </thead>
              <tbody>
                {entity.fields.map((field, i) => (
                  <tr key={field.id} className="border-b border-border/50 hover:bg-accent/30 transition-colors">
                    <td className="px-space-4 py-space-3 text-caption text-muted-foreground">
                      {i + 1}
                    </td>
                    <td className="px-space-4 py-space-3 font-mono text-body-small text-foreground">
                      {field.name}
                    </td>
                    <td className="px-space-4 py-space-3 text-body-small text-muted-foreground">
                      {field.type}
                      {field.precision != null && `(${field.precision}${field.scale != null ? `,${field.scale}` : ""})`}
                    </td>
                    <td className="px-space-4 py-space-3 text-body-small text-muted-foreground">
                      {field.nullable ? "Yes" : "No"}
                    </td>
                    <td className="px-space-4 py-space-3 text-body-small">
                      {field.isKey && <Badge variant="outline" className="text-caption">KEY</Badge>}
                    </td>
                    <td className="px-space-4 py-space-3">
                      {field.classification && (
                        <span className={`badge-${field.classification.toLowerCase()} text-caption px-1.5 py-0.5 rounded`}>
                          {field.classification}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Implemented Schemas section */}
      <div>
        <h2 className="text-heading-2 text-foreground mb-space-4">
          Implemented Schemas
        </h2>
        <div className="surface-glass rounded-xl border border-border p-space-8 text-center">
          <p className="text-body text-muted-foreground">
            No implementations yet — emit this entity to generate target schemas
          </p>
        </div>
      </div>
    </div>
  );
}
