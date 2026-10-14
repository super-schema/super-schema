import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { FieldStudio } from "./field-studio";
import { domainLabel } from "@/lib/entity-placement";

interface Props {
  params: Promise<{ domainSlug: string; productSlug: string; entityId: string; fieldId: string }>;
}

export default async function FieldDetailPage({ params }: Props) {
  const { domainSlug, productSlug, entityId, fieldId } = await params;

  // Resolve the entity first (param may be slug or cuid)
  const entity = await prisma.entity.findFirst({
    where: {
      OR: [{ id: entityId }, { slug: entityId }],
    },
    include: { domain: true },
  });
  if (!entity) notFound();

  // Try slug-based lookup first, fall back to id-based lookup
  let field = await prisma.field.findFirst({
    where: { slug: fieldId, entityId: entity.id },
    include: {
      entity: {
        include: { domain: true },
      },
    },
  });
  if (!field) {
    field = await prisma.field.findUnique({
      where: { id: fieldId },
      include: {
        entity: {
          include: { domain: true },
        },
      },
    });
  }

  if (!field || field.entityId !== entity.id) {
    notFound();
  }

  // Tenant-level entities have no domain and therefore no domain policy.
  const domain = field.entity.domain;
  const domainPolicy =
    (domain as { policyTemplate?: Record<string, unknown> } | null)
      ?.policyTemplate ?? null;

  return (
    <FieldStudio
      field={{
        id: field.id,
        name: field.name,
        type: field.type,
        precision: field.precision,
        scale: field.scale,
        nullable: field.nullable,
        isKey: field.isKey,
        fieldNumber: field.fieldNumber,
        description: field.description,
        classification: field.classification,
        aliases: field.aliases,
        decorators: field.decorators as Record<string, unknown>,
      }}
      entity={{
        id: field.entity.id,
        name: field.entity.name,
        slug: field.entity.slug,
        domainSlug,
        productSlug,
      }}
      domain={{
        name: domainLabel(domain),
        policy: domainPolicy as Record<string, unknown> | null,
      }}
    />
  );
}
