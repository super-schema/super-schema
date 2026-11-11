import { suggestBump } from "@/lib/entity-versioning/bump-suggestion";
import type { FieldSnapshot } from "@/services/version-history/version.types";
import type { CanonicalDocument } from "./contracts";
const DOC_KEYS = new Set([
  "description",
  "summary",
  "examples",
  "example",
  "valueDescriptions",
  "sortOrder",
]);
function structure(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structure);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !DOC_KEYS.has(key) &&
            key !== "typespecSource" &&
            key !== "version" &&
            key !== "versionRecord",
        )
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, structure(v)]),
    );
  return value;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(structure(a)) === JSON.stringify(structure(b));
export function minimumVersion(
  previous: CanonicalDocument | undefined,
  current: CanonicalDocument,
): string {
  if (!previous?.version) return "1.0.0_snapshot";
  let bump: "MAJOR" | "MINOR" | "PATCH" = "PATCH";
  if (current.kind === "Entity") {
    bump = suggestBump(
      (previous.spec.children.fields ?? []) as unknown as FieldSnapshot[],
      (current.spec.children.fields ?? []) as unknown as FieldSnapshot[],
    ).bump;
    if (
      !same(previous.spec.record, current.spec.record) ||
      !same(previous.references, current.references)
    )
      bump = "MAJOR";
  } else if (
    !same(previous.spec, current.spec) ||
    !same(previous.references, current.references)
  ) {
    if (current.kind === "Enum") {
      const before = previous.spec.record.values as string[],
        after = current.spec.record.values as string[];
      bump = before.some((v) => !after.includes(v)) ? "MAJOR" : "MINOR";
    } else bump = "MAJOR";
  }
  const [major, minor, patch] = previous.version
    .replace(/_snapshot$/, "")
    .split(".")
    .map(Number);
  return `${bump === "MAJOR" ? major + 1 : major}.${bump === "MAJOR" ? 0 : bump === "MINOR" ? minor + 1 : minor}.${bump === "PATCH" ? patch + 1 : 0}_snapshot`;
}
