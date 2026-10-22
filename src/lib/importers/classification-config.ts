import { setOwn } from "@/lib/compiler/governance-decorators";

/**
 * Where the importer finds a field's data security classification in a JSON Schema property, and how the vendor's
 * level strings map to the app's classification levels. Deliberately a module + env override (no DB model): the
 * vendor key can be renamed without a migration.
 *
 *   SCHEMA_CLASSIFICATION_EXTENSION_KEY    property key holding the block        (default "x-securityClassification")
 *   SCHEMA_CLASSIFICATION_LEVEL_FIELD      block member holding the level        (default "data_class")
 *   SCHEMA_CLASSIFICATION_CATEGORY_FIELD   block member holding the category     (default "data_category")
 *   SCHEMA_CLASSIFICATION_VALUE_MAP        JSON object { "<raw level>": "<app level>" } (default: identity)
 */
export interface ClassificationConfig {
  extensionKey: string;
  levelField: string;
  categoryField: string;
  /** Null-prototype object; look up with `Object.hasOwn`. */
  valueMap: Record<string, string>;
}

export const DEFAULT_CLASSIFICATION_EXTENSION_KEY = "x-securityClassification";
export const DEFAULT_CLASSIFICATION_LEVEL_FIELD = "data_class";
export const DEFAULT_CLASSIFICATION_CATEGORY_FIELD = "data_category";

const MAX_NAME_LENGTH = 100;
const MAX_MAP_ENTRIES = 200;
const MAX_MAP_STRING_LENGTH = 200;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const warned = new Set<string>();

/** One console.warn per distinct problem (process-wide); tests reset it. */
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[classification-config] ${message}`);
}

export function resetClassificationConfigWarnings(): void {
  warned.clear();
}

function readName(env: NodeJS.ProcessEnv | Record<string, string | undefined>, variable: string, fallback: string): string {
  const raw = env[variable];
  if (raw === undefined) return fallback;
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.length > MAX_NAME_LENGTH || CONTROL_CHARS.test(value)) {
    warnOnce(`${variable} must be a non-empty string of at most ${MAX_NAME_LENGTH} characters without control characters; using the default`);
    return fallback;
  }
  return value;
}

function readValueMap(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = Object.create(null);
  if (raw === undefined || raw.trim() === "") return map;
  const ignore = (why: string): Record<string, string> => {
    warnOnce(`SCHEMA_CLASSIFICATION_VALUE_MAP ignored: ${why}`);
    return Object.create(null);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ignore("not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ignore("must be a JSON object");
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_MAP_ENTRIES) return ignore(`more than ${MAX_MAP_ENTRIES} entries`);
  for (const [key, value] of entries) {
    const k = key.trim();
    if (typeof value !== "string") return ignore("every value must be a string");
    const v = value.trim();
    if (!k || !v || k.length > MAX_MAP_STRING_LENGTH || v.length > MAX_MAP_STRING_LENGTH) {
      return ignore(`keys and values must be non-empty strings of at most ${MAX_MAP_STRING_LENGTH} characters`);
    }
    setOwn(map, k, v);
  }
  return map;
}

/** Read per call (never cached) so a changed environment takes effect and tests can vary it. */
export function getClassificationConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ClassificationConfig {
  return {
    extensionKey: readName(env, "SCHEMA_CLASSIFICATION_EXTENSION_KEY", DEFAULT_CLASSIFICATION_EXTENSION_KEY),
    levelField: readName(env, "SCHEMA_CLASSIFICATION_LEVEL_FIELD", DEFAULT_CLASSIFICATION_LEVEL_FIELD),
    categoryField: readName(env, "SCHEMA_CLASSIFICATION_CATEGORY_FIELD", DEFAULT_CLASSIFICATION_CATEGORY_FIELD),
    valueMap: readValueMap(env.SCHEMA_CLASSIFICATION_VALUE_MAP),
  };
}
