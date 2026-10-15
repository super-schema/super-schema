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

/** A level-tagged row. `count` (default 1) lets a Prisma `groupBy` result stand in for its rows. */
type LevelRow = { domainId: string | null; productId: string | null; count?: number };

export interface ExplorerRows {
  domains: Array<{ id: string; name: string; slug: string; isSystem: boolean }>;
  products: Array<{ id: string; domainId: string; name: string; slug: string; isSystem: boolean }>;
  entities: Array<ExplorerEntity & LevelRow>;
  dataTypes: LevelRow[];
  services: LevelRow[];
  traits?: LevelRow[];
  messages?: LevelRow[];
  channels?: LevelRow[];
  eventSpecs?: LevelRow[];
}

const TENANT = "__tenant__";
const keyOf = (r: LevelRow) => r.productId ?? r.domainId ?? TENANT;

function countBy(rows: LevelRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + (r.count ?? 1));
  return m;
}

/**
 * Pure shaping of flat level-tagged rows into the Enterprise → Domain →
 * Product explorer tree (spec §4.4). A row's level is derived from its
 * columns: productId → product, else domainId → domain, else tenant.
 * Counts every level-tagged kind; traits at every level, events kinds per product.
 */
export function buildExplorerTree(input: ExplorerRows): ExplorerTree {
  const dataTypes = countBy(input.dataTypes);
  const services = countBy(input.services);
  const traits = countBy(input.traits ?? []);
  const messages = countBy(input.messages ?? []);
  const channels = countBy(input.channels ?? []);
  const eventSpecs = countBy(input.eventSpecs ?? []);
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
      counts: { dataTypes: dataTypes.get(TENANT) ?? 0, entities: tenantEntities.length, traits: traits.get(TENANT) ?? 0 },
      entities: tenantEntities,
    },
    domains: input.domains.map((d) => ({
      id: d.id,
      name: d.name,
      slug: d.slug,
      isSystem: d.isSystem,
      counts: { dataTypes: dataTypes.get(d.id) ?? 0, apis: services.get(d.id) ?? 0, traits: traits.get(d.id) ?? 0 },
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
              traits: traits.get(p.id) ?? 0,
              messages: messages.get(p.id) ?? 0,
              channels: channels.get(p.id) ?? 0,
              eventSpecs: eventSpecs.get(p.id) ?? 0,
            },
            entities,
          };
        }),
    })),
  };
}
