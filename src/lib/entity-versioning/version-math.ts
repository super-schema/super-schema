import { ok, err, type Result } from "@/types/result";
import type { BumpKind, ChangeKind, VersionNumber, VersionStage } from "./types";

export const INITIAL_VERSION: VersionNumber = { major: 1, minor: 0, patch: 0 };

/** `{ 1, 1, 0 }` → `"1.1.0"`; with `"SNAPSHOT"` → `"1.1.0_snapshot"`. */
export function formatVersionLabel(v: VersionNumber, stage: VersionStage = "RELEASED"): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return stage === "SNAPSHOT" ? `${base}_snapshot` : base;
}

const LABEL = /^v?(\d+)\.(\d+)(?:\.(\d+))?(_snapshot)?$/;

/** Versions live in Postgres `Int` columns: a part beyond this can never exist, and querying it throws instead of finding nothing. */
const MAX_VERSION_PART = 2_147_483_647;

/** Parse `"1.1.0"` / `"v1.1.0"` / `"1.1.0_snapshot"`; legacy `"2.1"` / `"v2.1"` is 2.1.0 RELEASED. Versions start at 1.0.0; a part above `MAX_VERSION_PART` (including a 400-digit one) is not a label. */
export function parseVersionLabel(label: string): Result<VersionNumber & { stage: VersionStage }> {
  const match = LABEL.exec(label.trim());
  const major = match ? Number(match[1]) : NaN;
  const minor = match ? Number(match[2]) : NaN;
  const patch = match?.[3] === undefined ? 0 : Number(match[3]);
  if (
    !match || major < 1 || major > MAX_VERSION_PART || minor > MAX_VERSION_PART || patch > MAX_VERSION_PART
  ) {
    return err({
      code: "VALIDATION_ERROR",
      message: `"${label}" is not a version label`,
      suggestedFix: 'Use MAJOR.MINOR.PATCH starting at 1.0.0, e.g. "2.1.0" or "2.1.0_snapshot".',
    });
  }
  return ok({ major, minor, patch, stage: match[4] ? "SNAPSHOT" : "RELEASED" });
}

/** First release is always 1.0.0 INITIAL; afterwards MAJOR → (M+1).0.0, MINOR → M.(m+1).0, PATCH → M.m.(p+1). */
export function nextVersionNumber(
  latestRelease: VersionNumber | null,
  bump: BumpKind
): { version: VersionNumber; changeKind: ChangeKind } {
  if (!latestRelease) return { version: INITIAL_VERSION, changeKind: "INITIAL" };
  const { major, minor, patch } = latestRelease;
  switch (bump) {
    case "MAJOR":
      return { version: { major: major + 1, minor: 0, patch: 0 }, changeKind: "MAJOR" };
    case "MINOR":
      return { version: { major, minor: minor + 1, patch: 0 }, changeKind: "MINOR" };
    case "PATCH":
      return { version: { major, minor, patch: patch + 1 }, changeKind: "PATCH" };
  }
}

const BUMP_RANK: Record<BumpKind, number> = { PATCH: 0, MINOR: 1, MAJOR: 2 };

/** Raise-only: the user may raise PATCH < MINOR < MAJOR, never lower below the suggestion. */
export function resolveBump(suggested: BumpKind, requested: BumpKind | undefined): Result<BumpKind> {
  if (requested === undefined) return ok(suggested);
  if (BUMP_RANK[requested] < BUMP_RANK[suggested]) {
    return err({
      code: "BUMP_TOO_LOW",
      message: `These changes require at least a ${suggested} version bump.`,
      suggestedFix: `Publish as ${suggested} or higher.`,
    });
  }
  return ok(requested);
}

/** Negative when `a < b`, zero when equal, positive when `a > b` (stage ignored). */
export function compareVersions(a: VersionNumber, b: VersionNumber): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * The stored-row filter a parsed label names: its full number on the `(owner, major, minor, patch)` unique key plus its stage, so
 * `"2.1.0_snapshot"` never finds the released 2.1.0 row (or `"2.1.0"` an open 2.1.0 snapshot), and `"2.1.7"` finds only a 2.1.7 row.
 * Use with `findUnique({ where: { entityId_major_minor_patch: { entityId, major, minor, patch }, stage } })`.
 */
export function storedVersionWhere(v: VersionNumber & { stage: VersionStage }): VersionNumber & { stage: VersionStage } {
  return { major: v.major, minor: v.minor, patch: v.patch, stage: v.stage };
}
