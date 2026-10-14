const RESERVED_SCHEMA_ROUTE_SLUGS = new Set(["type-mappings", "enterprise"]);

// Static route segments that sit beside the dynamic [entityId] segment
// (/schemas/[domainSlug]/[productSlug]/<segment>). An entity whose slug
// matches one would be shadowed by the static page and become unreachable.
const RESERVED_ENTITY_ROUTE_SLUGS = new Set([
  "new", "events", "channels", "messages", "specs", "traits", "data-types", "apis",
]);

// Static route segment /schemas/<domain>/traits/<id> sits beside the dynamic [productSlug],
// so a product with slug "traits" would shadow the domain-level traits list.
const RESERVED_PRODUCT_ROUTE_SLUGS = new Set(["traits"]);

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

export function isReservedProductRouteSlug(slug: string): boolean {
  return RESERVED_PRODUCT_ROUTE_SLUGS.has(slug);
}

export function reservedEntitySlugMessage(name: string): string | null {
  const slug = generateSlug(name);
  if (isReservedEntityRouteSlug(slug)) {
    return `"${name}" can't be used as an entity name — its URL segment "${slug}" is reserved.`;
  }
  return null;
}
