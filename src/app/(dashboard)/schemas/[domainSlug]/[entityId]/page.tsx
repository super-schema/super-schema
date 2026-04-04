import { prisma } from "@/lib/db";
import { fromSlug } from "@/lib/domain-utils";
import { notFound } from "next/navigation";
import { EntityWorkspace } from "./entity-workspace";

interface Props {
  params: Promise<{ domainSlug: string; entityId: string }>;
}

export default async function EntityDetailPage({ params }: Props) {
  const { domainSlug, entityId } = await params;

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

  const domainPolicy = (entity.domain as { policyTemplate?: Record<string, unknown> }).policyTemplate ?? null;

  return (
    <EntityWorkspace
      entity={{
        id: entity.id,
        name: entity.name,
        description: entity.description,
        status: entity.status,
        version: entity.version,
        domainName: entity.domain.name,
        domainSlug,
        metadata: entity.metadata as Record<string, unknown> | null,
      }}
      domainPolicy={domainPolicy as Record<string, unknown> | null}
      fields={entity.fields.map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        precision: f.precision,
        scale: f.scale,
        nullable: f.nullable,
        isKey: f.isKey,
        fieldNumber: f.fieldNumber,
        description: f.description,
        classification: f.classification,
        aliases: f.aliases,
        decorators: f.decorators as Record<string, unknown>,
        sortOrder: f.sortOrder,
      }))}
    />
  );
}
