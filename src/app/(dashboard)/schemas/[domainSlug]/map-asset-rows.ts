import type {
  CustomScalarData,
  SharedEnumData,
  UnionTypeData,
} from "./components/DomainTypesTab";
import type { ServiceData } from "./components/DomainApisTab";

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
