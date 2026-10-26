import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { prisma } from "@/lib/db";
import { EntityCreationWizard } from "@/components/custom/EntityCreationWizard";
import { notFound } from "next/navigation";
import { can } from "@/lib/access";
import { requirePageAccess } from "@/lib/access/page-access";
import { assetHref } from "@/lib/navigation/asset-href";
import { HideEmptyRightPanel } from "@/components/layout/HideEmptyRightPanel";
import { levelLabel } from "@/lib/levels";

export default async function NewEnterpriseEntityPage() {
  const { principal, tenantId } = await requirePageAccess();

  // Creating a tenant-level entity needs `entity.write` over the tenant as a whole (a tenant author or above, or a platform role); anyone else is told 404.
  if (!can(principal.assignments, "entity.write", { tenantId })) notFound();

  // Existing Enterprise entities — offered as $ref targets in the visual builder.
  const referenceTargets = await prisma.entity.findMany({
    where: { tenantId, domainId: null, productId: null },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return (
    <div className="animate-auth-fade-up">
      <HideEmptyRightPanel />
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-space-1 text-body-small text-muted-foreground mb-space-4">
        <Link
          href={assetHref({ kind: "enterprise" })}
          className="hover:text-foreground transition-colors"
        >
          {levelLabel("TENANT")}
        </Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-foreground font-medium">New Entity</span>
      </nav>

      {/* AI generation reads a domain's entities for context, so it is not offered
          for Enterprise entities (the wizard hides that method at TENANT level). */}
      <EntityCreationWizard
        target={{ level: "TENANT", tenantId }}
        referenceTargets={referenceTargets}
      />
    </div>
  );
}
