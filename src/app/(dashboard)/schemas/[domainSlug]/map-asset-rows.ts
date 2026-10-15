import { assetHref } from "@/lib/navigation/asset-href";
import type {
  CustomScalarData,
  InheritedDataTypes,
  SharedEnumData,
  UnionTypeData,
} from "./components/DomainTypesTab";
import type { InheritedServices, ServiceData } from "./components/DomainApisTab";

/**
 * Row -> UI-shape mapping shared by the domain page and the product page.
 * Inputs are structural so they accept Prisma rows (which carry extra
 * columns) from any level-scoped query.
 */

interface SharedEnumRow {
  id: string;
  name: string;
  values: string[];
  description: string;
}

interface CustomScalarRow {
  id: string;
  name: string;
  baseType: string;
  format: string | null;
  pattern: string | null;
  description: string;
}

interface UnionTypeRow {
  id: string;
  name: string;
  memberTypes: string[];
  description: string;
}

interface ServiceRow {
  id: string;
  name: string;
  description: string;
  basePath: string;
  scope: ServiceData["scope"];
  entity: { id: string; name: string; slug: string } | null;
  operations: {
    id: string;
    name: string;
    httpMethod: string;
    httpPath: string;
    description: string;
    parameters: {
      name: string;
      type: string;
      location: string;
      required: boolean;
      description: string;
    }[];
    responses: {
      statusCode: number;
      type: string | null;
      description: string;
    }[];
  }[];
}

export function mapSharedEnumRows(rows: SharedEnumRow[]): SharedEnumData[] {
  return rows.map((e) => ({
    id: e.id,
    name: e.name,
    values: e.values,
    description: e.description,
  }));
}

export function mapCustomScalarRows(rows: CustomScalarRow[]): CustomScalarData[] {
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    baseType: s.baseType,
    format: s.format,
    pattern: s.pattern,
    description: s.description,
  }));
}

export function mapUnionTypeRows(rows: UnionTypeRow[]): UnionTypeData[] {
  return rows.map((u) => ({
    id: u.id,
    name: u.name,
    memberTypes: u.memberTypes,
    description: u.description,
  }));
}

export function mapServiceRows(rows: ServiceRow[]): ServiceData[] {
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    basePath: s.basePath,
    scope: s.scope,
    entity: s.entity
      ? { id: s.entity.id, name: s.entity.name, slug: s.entity.slug }
      : null,
    operations: s.operations.map((op) => ({
      id: op.id,
      name: op.name,
      httpMethod: op.httpMethod,
      httpPath: op.httpPath,
      description: op.description,
      parameters: op.parameters.map((pr) => ({
        name: pr.name,
        type: pr.type,
        location: pr.location,
        required: pr.required,
        description: pr.description,
      })),
      responses: op.responses.map((r) => ({
        statusCode: r.statusCode,
        type: r.type,
        description: r.description,
      })),
    })),
  }));
}

/**
 * Inherited sections of a product workspace. A product inherits data types
 * from its domain and from the Enterprise, and API services from its domain.
 * Empty groups are dropped; links go to the owning level's tab via assetHref.
 */
export function buildProductInheritedDataTypes(args: {
  domainSlug: string;
  domain: Pick<InheritedDataTypes, "sharedEnums" | "customScalars" | "unionTypes">;
  enterprise: Pick<InheritedDataTypes, "sharedEnums" | "customScalars" | "unionTypes">;
}): InheritedDataTypes[] {
  const groups: InheritedDataTypes[] = [
    {
      label: "From Domain",
      href: assetHref({ kind: "dataTypes", domainSlug: args.domainSlug, productSlug: null }),
      ...args.domain,
    },
    {
      label: "From Enterprise",
      href: assetHref({ kind: "dataTypes", domainSlug: null, productSlug: null }),
      ...args.enterprise,
    },
  ];
  return groups.filter((g) => g.sharedEnums.length + g.customScalars.length + g.unionTypes.length > 0);
}

export function buildProductInheritedServices(args: {
  domainSlug: string;
  domain: ServiceData[];
}): InheritedServices[] {
  if (args.domain.length === 0) return [];
  return [
    {
      label: "From Domain",
      href: assetHref({ kind: "apis", domainSlug: args.domainSlug, productSlug: null }),
      services: args.domain,
    },
  ];
}
