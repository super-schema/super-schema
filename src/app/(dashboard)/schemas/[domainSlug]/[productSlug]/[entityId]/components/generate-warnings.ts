/**
 * What the Schemas tab says when a target was generated WITH warnings (status WARNING: the DDL exists, but a name is
 * unsafe, a column was skipped, ...). One toast, shown instead of the plain "generated" one. Pure, client-safe.
 */

/** The first warning is cut to this many characters. */
const MAX_FIRST_WARNING = 200;

/**
 * `Generated with N warning(s): <first warning>`, plus ` (and N-1 more in the preview)` when there are more, one full stop.
 * Null when there is nothing to warn about (the caller then shows its usual success text).
 */
export function generationWarningNotice(warnings: readonly string[] | undefined): string | null {
  if (!warnings || warnings.length === 0) return null;
  const first = warnings[0].trim().replace(/\.$/, "");
  const shown = first.length > MAX_FIRST_WARNING ? `${first.slice(0, MAX_FIRST_WARNING - 1).trimEnd()}…` : first;
  const more = warnings.length > 1 ? ` (and ${warnings.length - 1} more in the preview)` : "";
  return `Generated with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}: ${shown}${more}.`;
}
