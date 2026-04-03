import { prisma } from "@/lib/db";
import { DomainGrid } from "./domain-grid";

export default async function SchemasPage() {
  const domains = await prisma.domain.findMany({
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    include: {
      _count: { select: { entities: true } },
    },
  });

  return (
    <DomainGrid
      domains={domains.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        isSystem: d.isSystem,
        entityCount: d._count.entities,
        createdAt: d.createdAt,
      }))}
    />
  );
}
