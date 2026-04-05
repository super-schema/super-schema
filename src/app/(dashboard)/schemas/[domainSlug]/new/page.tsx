import { prisma } from "@/lib/db";
import { fromSlug } from "@/lib/domain-utils";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { EntityCreationWizard } from "@/components/custom/EntityCreationWizard";
import { isAiConfigured } from "@/services/ai.service";

interface Props {
  params: Promise<{ domainSlug: string }>;
}

export default async function NewEntityPage({ params }: Props) {
  const { domainSlug } = await params;
  const domainName = fromSlug(domainSlug);

  const domain = await prisma.domain.findFirst({
    where: { name: { equals: domainName, mode: "insensitive" } },
  });

  if (!domain) {
    notFound();
  }

  const aiConfigured = isAiConfigured();

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
          {domain.name}
        </Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-foreground font-medium">New Entity</span>
      </nav>

      <EntityCreationWizard
        domainId={domain.id}
        domainName={domain.name}
        domainSlug={domainSlug}
        isAiConfigured={aiConfigured}
      />
    </div>
  );
}
