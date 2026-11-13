export type ClassNumber = 1 | 2 | 3 | 4 | 5;

/** The fixed 1-5 class scale (1 = most restrictive). Not tenant-editable. `label` is the short name. */
export const CLASS_SCALE = [
  { level: "NEVER_STORED", classNumber: 1, label: "Never Stored" },
  { level: "PII", classNumber: 2, label: "PII" },
  { level: "SENSITIVE", classNumber: 3, label: "Sensitive" },
  { level: "INTERNAL", classNumber: 4, label: "Internal" },
  { level: "PUBLIC", classNumber: 5, label: "Public" },
] as const satisfies readonly { level: string; classNumber: ClassNumber; label: string }[];

/** Unclassified (and unknown) levels count as class 3 (SENSITIVE). */
export const DEFAULT_CLASS: ClassNumber = 3;

/**
 * The class of a level: a standard level (any case), a tenant custom level via `custom`, or a vendor `class1`..`class5` level;
 * anything else (or nothing) is DEFAULT_CLASS.
 */
export function classNumberOf(level: string | null | undefined, custom?: ReadonlyMap<string, number>): ClassNumber {
  if (!level) return DEFAULT_CLASS;
  const upper = level.toUpperCase();
  const standard = CLASS_SCALE.find((c) => c.level === upper);
  if (standard) return standard.classNumber;
  const mapped = custom?.get(upper);
  if (mapped !== undefined && Number.isInteger(mapped) && mapped >= 1 && mapped <= 5) return mapped as ClassNumber;
  const vendor = /^class([1-5])$/i.exec(level);
  if (vendor) return Number(vendor[1]) as ClassNumber;
  return DEFAULT_CLASS;
}

export function systemLevelForClass(n: ClassNumber): string {
  return CLASS_SCALE.find((c) => c.classNumber === n)!.level;
}

/** `"Class 3 — Sensitive"` for a standard level; any other level is returned as itself. */
export function classLabel(level: string): string {
  const upper = level.toUpperCase();
  const standard = CLASS_SCALE.find((c) => c.level === upper);
  return standard ? `Class ${standard.classNumber} — ${standard.label}` : level;
}
