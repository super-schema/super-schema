import { ok, err, type Result } from "@/types/result";
import type { BumpKind, ChangeKind, VersionNumber } from "./types";

export const INITIAL_VERSION: VersionNumber = { major: 1, minor: 0 };

/** `{ major: 2, minor: 1 }` → `"2.1"` (spec Q6: MAJOR.MINOR, no patch). */
export function formatVersionLabel(v: VersionNumber): string {
  return `${v.major}.${v.minor}`;
}

const LABEL = /^v?(\d+)\.(\d+)$/;

/** Parse `"2.1"` / `"v2.1"`. Versions start at 1.0. */
export function parseVersionLabel(label: string): Result<VersionNumber> {
  const match = LABEL.exec(label.trim());
  const major = match ? Number(match[1]) : NaN;
  const minor = match ? Number(match[2]) : NaN;
  if (!match || major < 1) {
    return err({
      code: "VALIDATION_ERROR",
      message: `"${label}" is not a version label`,
      suggestedFix: 'Use MAJOR.MINOR starting at 1.0, e.g. "2.1".',
    });
  }
  return ok({ major, minor });
}

/** First publish is always 1.0 INITIAL; afterwards MAJOR → (M+1).0, MINOR → M.(m+1). */
export function nextVersionNumber(
  latest: VersionNumber | null,
  bump: BumpKind
): { version: VersionNumber; changeKind: ChangeKind } {
  if (!latest) return { version: INITIAL_VERSION, changeKind: "INITIAL" };
  return bump === "MAJOR"
    ? { version: { major: latest.major + 1, minor: 0 }, changeKind: "MAJOR" }
    : { version: { major: latest.major, minor: latest.minor + 1 }, changeKind: "MINOR" };
}

/** Raise-only (spec Q6): the user may raise MINOR → MAJOR, never lower MAJOR → MINOR. */
export function resolveBump(suggested: BumpKind, requested: BumpKind | undefined): Result<BumpKind> {
  if (requested === undefined) return ok(suggested);
  if (suggested === "MAJOR" && requested === "MINOR") {
    return err({
      code: "BUMP_TOO_LOW",
      message: "These changes are breaking and must be published as a MAJOR version.",
      suggestedFix: "Publish as MAJOR.",
    });
  }
  return ok(requested);
}
