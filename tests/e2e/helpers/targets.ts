/**
 * The targets the Schemas tab can generate, READ FROM THE CATALOG (src/lib/schema-targets/catalog.ts: `enabledInSchemaTab`), so a
 * target added to the catalog is picked up by every lifecycle spec without an edit here. Playwright's TS loader resolves the
 * relative import; the catalog is plain data with no path aliases.
 */
import { getSchemaTargetCatalog } from "../../../src/lib/schema-targets/catalog";

export const SCHEMA_TARGETS_FOR_TESTS = getSchemaTargetCatalog()
  .filter((t) => t.enabledInSchemaTab)
  .map((t) => ({ key: t.key, displayName: t.displayName, language: t.outputLanguage }));
