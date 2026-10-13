const RESERVED_SCHEMA_ROUTE_SLUGS = new Set(["type-mappings"]);

// Static route segments that sit beside the dynamic [entityId] segment
// (/schemas/[domainSlug]/[productSlug]/new). An entity whose slug matches one
// would be shadowed by the static page and become unreachable.
const RESERVED_ENTITY_ROUTE_SLUGS = new Set(["new"]);

export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_-]/g, '')  // keep underscores
    .replace(/[\s_]+/g, '-')         // spaces AND underscores → hyphens
    .replace(/-+/g, '-')             // collapse multiple hyphens
    .replace(/^-|-$/g, '');           // trim leading/trailing hyphens
}

export function isReservedSchemaRouteSlug(slug: string): boolean {
  return RESERVED_SCHEMA_ROUTE_SLUGS.has(slug);
}

export function isReservedEntityRouteSlug(slug: string): boolean {
  return RESERVED_ENTITY_ROUTE_SLUGS.has(slug);
}
