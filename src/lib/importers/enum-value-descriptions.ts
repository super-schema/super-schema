/** The `valueDescriptions` of a shared enum (stored JSON) as a symbol -> text map; `undefined` when there is none. Pure. */
export function readValueDescriptions(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string" && v !== "") out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}
