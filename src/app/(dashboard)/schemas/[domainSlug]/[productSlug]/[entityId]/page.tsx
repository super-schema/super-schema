import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { EntityWorkspace } from "./entity-workspace";
import { domainLabel, productSegment } from "@/lib/entity-placement";

interface Props {
  params: Promise<{ domainSlug: string; productSlug: string; entityId: string }>;
}

export default async function EntityDetailPage({ params }: Props) {
  const { domainSlug, productSlug, entityId } = await params;

  // Look up entity by slug within its product (human-readable URL),
  // fall back to cuid for backward-compatible / legacy links.
  const entityInclude = {
    domain: true,
    product: { select: { slug: true, name: true } },
    fields: { orderBy: { sortOrder: "asc" as const } },
    services: {
      include: {
        operations: {
          include: { parameters: true, responses: true },
          orderBy: { createdAt: "asc" as const },
        },
      },
    },
  };

  let entity = await prisma.entity.findFirst({
    where: {
      slug: entityId,
      product: { slug: productSlug, domain: { slug: domainSlug } },
    },
    include: entityInclude,
  });

  if (!entity) {
    entity = await prisma.entity.findFirst({
      where: { slug: entityId, domain: { slug: domainSlug } },
      include: entityInclude,
    });
  }

  if (!entity) {
    entity = await prisma.entity.findUnique({
      where: { id: entityId },
      include: entityInclude,
    });
  }

  if (!entity) {
    notFound();
  }

  // Tenant-level entities have no domain and therefore no domain policy.
  const domainPolicy =
    (entity.domain as { policyTemplate?: Record<string, unknown> } | null)
      ?.policyTemplate ?? null;

  return (
    <EntityWorkspace
      entity={{
        id: entity.id,
        name: entity.name,
        slug: entity.slug,
        description: entity.description,
        status: entity.status,
        version: entity.version,
        domainId: entity.domainId,
        domainName: domainLabel(entity.domain),
        domainSlug,
        productSlug: productSegment(entity.product),
        productName: entity.product?.name ?? null,
        metadata: entity.metadata as Record<string, unknown> | null,
      }}
      domainPolicy={domainPolicy as Record<string, unknown> | null}
      fields={entity.fields.map((f) => ({
        id: f.id,
        slug: f.slug,
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
      apiServiceId={entity.services[0]?.id ?? null}
      apiOperations={entity.services.flatMap((service) =>
        service.operations.map((op) => ({
          id: op.id,
          serviceId: service.id,
          name: op.name,
          httpMethod: op.httpMethod,
          httpPath: op.httpPath,
          description: op.description,
          parameters: op.parameters.map((p) => ({
            name: p.name,
            type: p.type,
            location: p.location,
            required: p.required,
            description: p.description,
          })),
          responses: op.responses.map((r) => ({
            statusCode: r.statusCode,
            type: r.type,
            description: r.description,
          })),
        }))
      )}
    />
  );
}
