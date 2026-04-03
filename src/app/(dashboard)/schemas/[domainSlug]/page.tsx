import { prisma } from "@/lib/db";
import { fromSlug } from "@/lib/domain-utils";
import { notFound } from "next/navigation";
import { DomainWorkspace } from "./domain-workspace";

interface Props {
  params: Promise<{ domainSlug: string }>;
}

export default async function DomainEntitiesPage({ params }: Props) {
  const { domainSlug } = await params;
  const domainName = fromSlug(domainSlug);

  const domain = await prisma.domain.findFirst({
    where: { name: { equals: domainName, mode: "insensitive" } },
    include: {
      entities: {
        orderBy: { updatedAt: "desc" },
        include: {
          _count: { select: { fields: true } },
          fields: {
            select: { classification: true },
          },
        },
      },
    },
  });

  if (!domain) {
    notFound();
  }

  const entities = domain.entities.map((e) => {
    const classifications = { PII: 0, SENSITIVE: 0, INTERNAL: 0, PUBLIC: 0 };
    for (const f of e.fields) {
      if (f.classification && f.classification in classifications) {
        classifications[f.classification as keyof typeof classifications]++;
      }
    }
    return {
      id: e.id,
      name: e.name,
      description: e.description,
      status: e.status,
      version: e.version,
      fieldCount: e._count.fields,
      updatedAt: e.updatedAt,
      classifications,
    };
  });

  return (
    <DomainWorkspace
      domainId={domain.id}
      domainName={domain.name}
      domainSlug={domainSlug}
      domainDescription={domain.description}
      entities={entities}
    />
  );
}
