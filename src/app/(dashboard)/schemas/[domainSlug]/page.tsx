import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { DomainWorkspace } from "./domain-workspace";

interface Props {
  params: Promise<{ domainSlug: string }>;
}

export default async function DomainEntitiesPage({ params }: Props) {
  const { domainSlug } = await params;

  const domain = await prisma.domain.findFirst({
    where: { slug: domainSlug },
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
      sharedEnums: {
        orderBy: { name: "asc" },
      },
      customScalars: {
        orderBy: { name: "asc" },
      },
      unionTypes: {
        orderBy: { name: "asc" },
      },
      services: {
        orderBy: { name: "asc" },
        include: {
          operations: {
            orderBy: { name: "asc" },
            include: {
              parameters: true,
              responses: true,
            },
          },
        },
      },
    },
  });

  if (!domain) {
    notFound();
  }

  const entities = domain.entities.map((e) => {
    const classifications = { NEVER_STORED: 0, PII: 0, SENSITIVE: 0, INTERNAL: 0, PUBLIC: 0 };
    for (const f of e.fields) {
      const cls = f.classification ?? "SENSITIVE";
      if (cls in classifications) {
        classifications[cls as keyof typeof classifications]++;
      }
    }
    return {
      id: e.id,
      name: e.name,
      slug: e.slug,
      description: e.description,
      status: e.status,
      version: e.version,
      fieldCount: e._count.fields,
      updatedAt: e.updatedAt,
      classifications,
    };
  });

  const sharedEnums = domain.sharedEnums.map((e) => ({
    id: e.id,
    name: e.name,
    values: e.values,
    description: e.description,
  }));

  const customScalars = domain.customScalars.map((s) => ({
    id: s.id,
    name: s.name,
    baseType: s.baseType,
    format: s.format,
    pattern: s.pattern,
    description: s.description,
  }));

  const unionTypes = domain.unionTypes.map((u) => ({
    id: u.id,
    name: u.name,
    memberTypes: u.memberTypes,
    description: u.description,
  }));

  const services = domain.services.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    basePath: s.basePath,
    operations: s.operations.map((op) => ({
      id: op.id,
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
    })),
  }));

  const domainPolicy = (domain as { policyTemplate?: Record<string, unknown> }).policyTemplate ?? null;

  return (
    <DomainWorkspace
      domainId={domain.id}
      domainName={domain.name}
      domainSlug={domainSlug}
      domainDescription={domain.description}
      domainPolicy={domainPolicy as Record<string, unknown> | null}
      entities={entities}
      sharedEnums={sharedEnums}
      customScalars={customScalars}
      unionTypes={unionTypes}
      services={services}
    />
  );
}
