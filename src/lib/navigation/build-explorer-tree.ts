export interface ExplorerEntity {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export interface ExplorerCounts {
  dataTypes: number;
  apis: number;
  entities: number;
  traits: number;
  messages: number;
  channels: number;
  eventSpecs: number;
}

export interface ExplorerProduct {
  id: string;
  name: string;
  slug: string;
  isSystem: boolean;
  counts: ExplorerCounts;
  entities: ExplorerEntity[];
}

export interface ExplorerDomain {
  id: string;
  name: string;
  slug: string;
  isSystem: boolean;
  counts: Pick<ExplorerCounts, "dataTypes" | "apis" | "traits">;
  products: ExplorerProduct[];
}

export interface ExplorerTree {
  enterprise: {
    counts: Pick<ExplorerCounts, "dataTypes" | "entities" | "traits">;
    entities: ExplorerEntity[];
  };
  domains: ExplorerDomain[];
}

type LevelRow = { domainId: string | null; productId: string | null };

export interface ExplorerRows {
  domains: Array<{ id: string; name: string; slug: string; isSystem: boolean }>;
  products: Array<{ id: string; domainId: string; name: string; slug: string; isSystem: boolean }>;
  entities: Array<ExplorerEntity & LevelRow>;
  dataTypes: LevelRow[];
  services: LevelRow[];
}

const TENANT = "__tenant__";
const keyOf = (r: LevelRow) => r.productId ?? r.domainId ?? TENANT;

function countBy(rows: LevelRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + 1);
  return m;
}

/**
 * Pure shaping of flat level-tagged rows into the Enterprise → Domain →
 * Product explorer tree (spec §4.4). A row's level is derived from its
 * columns: productId → product, else domainId → domain, else tenant.
 * Traits / messages / channels / eventSpecs counts are 0 until Phase 4.
 */
export function buildExplorerTree(input: ExplorerRows): ExplorerTree {
  const dataTypes = countBy(input.dataTypes);
  const services = countBy(input.services);
  const entitiesByKey = new Map<string, ExplorerEntity[]>();
  for (const e of [...input.entities].sort((a, b) => a.name.localeCompare(b.name))) {
    const k = keyOf(e);
    const bucket = entitiesByKey.get(k);
    const entity = { id: e.id, name: e.name, slug: e.slug, status: e.status };
    if (bucket) bucket.push(entity);
    else entitiesByKey.set(k, [entity]);
  }
  const tenantEntities = entitiesByKey.get(TENANT) ?? [];

  return {
    enterprise: {
      counts: { dataTypes: dataTypes.get(TENANT) ?? 0, entities: tenantEntities.length, traits: 0 },
      entities: tenantEntities,
    },
    domains: input.domains.map((d) => ({
      id: d.id,
      name: d.name,
      slug: d.slug,
      isSystem: d.isSystem,
      counts: { dataTypes: dataTypes.get(d.id) ?? 0, apis: services.get(d.id) ?? 0, traits: 0 },
      products: input.products
        .filter((p) => p.domainId === d.id)
        .sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.name.localeCompare(b.name))
        .map((p) => {
          const entities = entitiesByKey.get(p.id) ?? [];
          return {
            id: p.id,
            name: p.name,
            slug: p.slug,
            isSystem: p.isSystem,
            counts: {
              dataTypes: dataTypes.get(p.id) ?? 0,
              apis: services.get(p.id) ?? 0,
              entities: entities.length,
              traits: 0,
              messages: 0,
              channels: 0,
              eventSpecs: 0,
            },
            entities,
          };
        }),
    })),
  };
}
