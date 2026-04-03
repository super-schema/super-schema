import { prisma } from "@/lib/db";
import { fromSlug } from "@/lib/domain-utils";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface Props {
  params: Promise<{ domainSlug: string }>;
}

export default async function DomainEntitiesPage({ params }: Props) {
  const { domainSlug } = await params;
  const domainName = fromSlug(domainSlug);

  // Find domain by name (case-insensitive)
  const domain = await prisma.domain.findFirst({
    where: { name: { equals: domainName, mode: "insensitive" } },
    include: {
      entities: {
        orderBy: { updatedAt: "desc" },
        include: {
          _count: { select: { fields: true } },
        },
      },
    },
  });

  if (!domain) {
    notFound();
  }

  return (
    <div className="animate-auth-fade-up">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-space-1 text-body-small text-muted-foreground mb-space-6">
        <Link
          href="/schemas"
          className="hover:text-foreground transition-colors"
        >
          Domains
        </Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-foreground font-medium">{domain.name}</span>
      </nav>

      {/* Header */}
      <div className="flex items-center justify-between mb-space-6">
        <div>
          <h1 className="text-display text-foreground">{domain.name}</h1>
          {domain.description && (
            <p className="text-body text-muted-foreground mt-space-1">
              {domain.description}
            </p>
          )}
        </div>
        <Button className="gap-2">
          <Plus className="w-4 h-4" />
          New Entity
        </Button>
      </div>

      {/* Entity list or empty state */}
      {domain.entities.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <h2 className="text-heading-1 text-foreground mb-space-2">
            Create your first logical entity
          </h2>
          <p className="text-body text-muted-foreground mb-space-4">
            Get started by defining your first logical entity in{" "}
            <strong>{domain.name}</strong>
          </p>
          <Button className="gap-2">
            <Plus className="w-4 h-4" />
            Create Entity
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-space-4">
          {domain.entities.map((entity) => (
            <div
              key={entity.id}
              className="surface-glass rounded-xl border border-border p-space-6 hover:border-primary/30 transition-colors"
            >
              <div className="flex items-start justify-between mb-space-2">
                <h3 className="text-heading-3 text-foreground font-mono">
                  {entity.name}
                </h3>
                <div className="flex items-center gap-space-2">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      entity.status === "ACTIVE"
                        ? "bg-success"
                        : entity.status === "DRAFT"
                          ? "bg-warning"
                          : "bg-muted-foreground"
                    }`}
                  />
                  <Badge variant="outline" className="text-caption">
                    {entity.status}
                  </Badge>
                </div>
              </div>
              <p className="text-body-small text-muted-foreground line-clamp-2 mb-space-3">
                {entity.description || "No description"}
              </p>
              <div className="flex items-center gap-space-3 text-caption text-muted-foreground">
                <span>{entity._count.fields} fields</span>
                <span>v{entity.version}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
