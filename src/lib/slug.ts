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

// The special letters that have no decomposition, and the spelling a URL gives them (ß -> ss, æ -> ae, ...).
const SPECIAL_LETTERS: Readonly<Record<string, string>> = {
  ß: "ss", æ: "ae", œ: "oe", ø: "o", đ: "d", ð: "d", ł: "l", þ: "th", ı: "i",
};

/**
 * Lowercase, with the accents (combining marks) removed and the special letters spelled out: `Café` -> `cafe`. The compatibility forms come
 * first: `ℕ` and `𝐇` are a capital N and H, which the lowercasing does not change, so lowercasing before the NFKD would drop them.
 */
function foldLatin(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[ßæœøđðłþı]/g, (letter) => SPECIAL_LETTERS[letter]);
}

/**
 * A 53-bit hash of `text` in base 36 (cyrb53, public domain). Pure arithmetic, so a name gets the same hash in the browser and on the server.
 */
function stableHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * The URL name (slug) of a name: lowercase ASCII letters, digits and hyphens, which is what the routes and the stored slugs use. Accents are
 * folded and the special letters spelled out (`Café` -> `cafe`, `Größe` -> `grosse`). A letter that cannot be spelled in ASCII (a non-Latin
 * script) is kept as a hash of the whole name: a name with no ASCII left gets `item-<hash>`, and a mixed name keeps its ASCII part with the hash
 * after it, so two different names do not share one slug. A name with no letter or digit in any script gets "": the entity, product and domain
 * paths refuse such a name before they store a slug (a field name of that kind is still stored with an empty slug, as it was before).
 */
export function generateSlug(name: string): string {
  const folded = foldLatin(name);
  const ascii = folded
    .replace(/[^a-z0-9\s_-]/g, '')  // keep underscores
    .replace(/[\s_]+/g, '-')         // spaces AND underscores → hyphens
    .replace(/-+/g, '-')             // collapse multiple hyphens
    .replace(/^-|-$/g, '');           // trim leading/trailing hyphens
  // A letter or digit that is not ASCII and did not fold into one: the name has a part that the ASCII slug cannot carry.
  const unspelled = /[\p{L}\p{N}]/u.test(folded.replace(/[ -~]/g, ""));
  if (!unspelled) return ascii;
  // The hash is of the name itself (not of its folded form), so names that fold alike but differ (`カ` and `ガ`) stay apart.
  const hash = stableHash(name.trim().normalize("NFC").toLowerCase());
  return ascii === "" ? `item-${hash}` : `${ascii}-${hash}`;
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
