import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { EntityCreationWizard } from "@/components/custom/EntityCreationWizard";
import { isAiConfigured } from "@/services/ai.service";
import { can, readableWhere } from "@/lib/access";
import { requirePageAccess } from "@/lib/access/page-access";
import { assetHref } from "@/lib/navigation/asset-href";
import { HideEmptyRightPanel } from "@/components/layout/HideEmptyRightPanel";

interface Props {
  params: Promise<{ domainSlug: string; productSlug: string }>;
}

export default async function NewEntityPage({ params }: Props) {
  const { domainSlug, productSlug } = await params;
  const { principal, tenantId } = await requirePageAccess();
  const assignments = principal.assignments;

  // The domain of the tenant in view and no other (a slug is not unique across tenants; it used to fall back to a tenant-agnostic lookup).
  const domain = await prisma.domain.findFirst({ where: { slug: domainSlug, tenantId } });

  if (!domain) {
    notFound();
  }

  const product = await prisma.product.findFirst({
    where: { slug: productSlug, domainId: domain.id },
  });

  // Creating an entity here needs `entity.write` over the product (an author of it, its domain or the tenant): a role that cannot create here, or none that covers
  // the product, is a 404 (the page is the wizard that writes; the action behind it asks again).
  if (!product || !can(assignments, "entity.write", { tenantId, domainId: domain.id, productId: product.id })) {
    notFound();
  }

  // Existing entities in this domain that the caller may read: offered as $ref targets in the visual builder (a name is not shown to a role that cannot read it).
  const referenceTargets = await prisma.entity.findMany({
    where: { domainId: domain.id, tenantId, ...readableWhere(assignments, "entity.read", tenantId) },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const aiConfigured = isAiConfigured();

  return (
    <div className="animate-auth-fade-up">
      <HideEmptyRightPanel />
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-space-1 text-body-small text-muted-foreground mb-space-4">
        <Link href="/schemas" className="hover:text-foreground transition-colors">
          Domains
        </Link>
        <ChevronRight className="w-3 h-3" />
        <Link
          href={assetHref({ kind: "domain", domainSlug })}
          className="hover:text-foreground transition-colors"
        >
          {domain.name}
        </Link>
        <ChevronRight className="w-3 h-3" />
        <Link
          href={assetHref({ kind: "product", domainSlug, productSlug })}
          className="hover:text-foreground transition-colors"
        >
          {product.name}
        </Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-foreground font-medium">New Entity</span>
      </nav>

      <EntityCreationWizard
        target={{
          level: "PRODUCT",
          productId: product.id,
          domainId: domain.id,
          domainName: domain.name,
          domainSlug,
          productSlug,
        }}
        isAiConfigured={aiConfigured}
        referenceTargets={referenceTargets}
      />
    </div>
  );
}
