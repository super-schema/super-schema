import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { resolveGlobalAdminAccess } from "@/lib/access-control";
import { notFound, redirect } from "next/navigation";
import { getActiveTenantId } from "@/lib/active-tenant";
import { DomainWorkspace } from "../domain-workspace";
import { productSegment } from "@/lib/entity-placement";
import {
  mapCustomScalarRows,
  mapServiceRows,
  mapSharedEnumRows,
  mapUnionTypeRows,
} from "../map-asset-rows";

interface Props {
  params: Promise<{ domainSlug: string; productSlug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ProductWorkspacePage({
  params,
  searchParams,
}: Props) {
  const { domainSlug, productSlug } = await params;
  const resolvedSearchParams: Record<string, string | string[] | undefined> =
    (await searchParams) ?? {};
  const [session, tenantId] = await Promise.all([auth(), getActiveTenantId()]);

  const domain =
    (await prisma.domain.findFirst({
      where: { slug: domainSlug, tenantId },
    })) ??
    (await prisma.domain.findFirst({ where: { slug: domainSlug } }));

  if (!domain) {
    notFound();
  }

  const [product, access] = await Promise.all([
    prisma.product.findFirst({
      where: { slug: productSlug, domainId: domain.id },
      include: {
        entities: {
          orderBy: { updatedAt: "desc" },
          include: {
            _count: { select: { fields: true } },
            fields: { select: { classification: true } },
          },
        },
      },
    }),
    resolveGlobalAdminAccess(session?.user),
  ]);

  if (!product) {
    // Back-compat: legacy 2-segment entity links (/schemas/<domain>/<entity>)
    // land here with productSlug holding the entity slug. Resolve and redirect
    // to the canonical 3-segment URL.
    const legacyEntity = await prisma.entity.findFirst({
      where: { slug: productSlug, domainId: domain.id },
      select: { slug: true, product: { select: { slug: true } } },
    });
    if (legacyEntity) {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(resolvedSearchParams)) {
        if (Array.isArray(value)) {
          value.forEach((v) => qs.append(key, v));
        } else if (value !== undefined) {
          qs.set(key, value);
        }
      }
      const suffix = qs.toString();
      redirect(
        `/schemas/${domainSlug}/${productSegment(legacyEntity.product)}/${legacyEntity.slug}${
          suffix ? `?${suffix}` : ""
        }`
      );
    }
    notFound();
  }

  const [
    counts,
    modelDefinitions,
    decoratorDefinitions,
    sharedEnumsRaw,
    customScalarsRaw,
    unionTypesRaw,
    servicesRaw,
  ] = await Promise.all([
    prisma.domain.findUnique({
      where: { id: domain.id },
      select: {
        _count: {
          select: {
            entities: true,
            modelDefinitions: true,
            decoratorDefinitions: true,
            sharedEnums: true,
            customScalars: true,
            unionTypes: true,
            services: true,
            interfaces: true,
            userRoles: true,
          },
        },
      },
    }),
    prisma.modelDefinition.findMany({
      where: { domainId: domain.id },
      orderBy: { name: "asc" },
      include: { fields: { orderBy: { sortOrder: "asc" } } },
    }),
    prisma.decoratorDefinition.findMany({
      where: { domainId: domain.id },
      orderBy: { name: "asc" },
    }),
    prisma.sharedEnum.findMany({
      where: { domainId: domain.id },
      orderBy: { name: "asc" },
    }),
    prisma.customScalar.findMany({
      where: { domainId: domain.id },
      orderBy: { name: "asc" },
    }),
    prisma.unionType.findMany({
      where: { domainId: domain.id },
      orderBy: { name: "asc" },
    }),
    prisma.serviceDefinition.findMany({
      where: { domainId: domain.id },
      orderBy: { name: "asc" },
      include: {
        entity: { select: { id: true, name: true, slug: true } },
        operations: {
          orderBy: { name: "asc" },
          include: { parameters: true, responses: true },
        },
      },
    }),
  ]);

  const entities = product.entities.map((e) => {
    const classifications = {
      NEVER_STORED: 0,
      PII: 0,
      SENSITIVE: 0,
      INTERNAL: 0,
      PUBLIC: 0,
    };
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

  const sharedEnums = mapSharedEnumRows(sharedEnumsRaw);
  const customScalars = mapCustomScalarRows(customScalarsRaw);
  const unionTypes = mapUnionTypeRows(unionTypesRaw);

  const models = modelDefinitions.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    extendsModelName: model.extendsModelName,
    fieldCount: model.fields.length,
    updatedAt: model.updatedAt,
    fields: model.fields.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      nullable: field.nullable,
      isKey: field.isKey,
      description: field.description,
    })),
  }));

  const decorators = decoratorDefinitions.map((decorator) => ({
    id: decorator.id,
    name: decorator.name,
    description: decorator.description,
    signature: decorator.signature,
    targetTypes: decorator.targetTypes,
  }));

  const services = mapServiceRows(servicesRaw);

  const domainPolicy =
    (domain as { policyTemplate?: Record<string, unknown> }).policyTemplate ??
    null;
  const c = counts?._count;

  return (
    <DomainWorkspace
      domainId={domain.id}
      domainName={domain.name}
      domainSlug={domainSlug}
      productId={product.id}
      productSlug={productSlug}
      productName={product.name}
      domainDescription={domain.description}
      isSystemDomain={domain.isSystem}
      canDeleteDomain={false}
      deletionImpact={{
        entities: c?.entities ?? 0,
        modelDefinitions: c?.modelDefinitions ?? 0,
        decoratorDefinitions: c?.decoratorDefinitions ?? 0,
        sharedEnums: c?.sharedEnums ?? 0,
        customScalars: c?.customScalars ?? 0,
        unionTypes: c?.unionTypes ?? 0,
        services: c?.services ?? 0,
        interfaces: c?.interfaces ?? 0,
        userRoles: c?.userRoles ?? 0,
      }}
      domainPolicy={domainPolicy as Record<string, unknown> | null}
      entities={entities}
      models={models}
      sharedEnums={sharedEnums}
      customScalars={customScalars}
      unionTypes={unionTypes}
      decoratorDefinitions={decorators}
      services={services}
    />
  );
}
