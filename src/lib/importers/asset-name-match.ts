/**
 * Matching an imported asset to the name a `$ref` used for it (pure).
 *
 * A reference names a FILE (`country_code.json`, `Orthography.v1.json`), an asset is named by its title / identifier (`CountryCode`), so the
 * two spellings differ in case and separators. Two names match when they are equal after dropping everything that is not a letter or digit
 * and lower-casing (`country_code` = `CountryCode` = `country-code`); a trailing `.v1` version is ignored like `refToEntityName` does.
 */
export function normalizeAssetName(name: string): string {
  return name
    .replace(/\.(schema\.json|json)$/i, "")
    .replace(/\.v\d+$/i, "")
    .replace(/[^A-Za-z0-9]+/g, "")
    .toLowerCase();
}

export function sameAssetName(a: string, b: string): boolean {
  const na = normalizeAssetName(a);
  return na !== "" && na === normalizeAssetName(b);
}
