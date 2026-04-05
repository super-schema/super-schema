import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { FieldStudio } from "./field-studio";

interface Props {
  params: Promise<{ domainSlug: string; entityId: string; fieldId: string }>;
}

export default async function FieldDetailPage({ params }: Props) {
  const { domainSlug, entityId, fieldId } = await params;

  const field = await prisma.field.findUnique({
    where: { id: fieldId },
    include: {
      entity: {
        include: { domain: true },
      },
    },
  });

  // entityId param may be a slug or a cuid — accept either
  if (!field || (field.entityId !== entityId && field.entity.slug !== entityId)) {
    notFound();
  }

  const domain = field.entity.domain;
  const domainPolicy =
    (domain as { policyTemplate?: Record<string, unknown> }).policyTemplate ??
    null;

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
      }}
      domain={{
        name: domain.name,
        policy: domainPolicy as Record<string, unknown> | null,
      }}
    />
  );
}
