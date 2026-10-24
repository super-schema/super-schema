/**
 * A count with its noun: `pluralize(1, "field")` is "1 field", `pluralize(2, "field")` "2 fields", `pluralize(1, "entity", "entities")`
 * "1 entity". Only exactly 1 is singular (0 and 2 are plural), as in English; a count label written `{n} fields` says "1 fields".
 */
export function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
