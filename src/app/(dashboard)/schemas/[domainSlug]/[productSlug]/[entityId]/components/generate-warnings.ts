/**
 * What the Schemas tab says when targets were generated WITH warnings (status WARNING: the DDL exists, but a name is unsafe,
 * a column was skipped, ...). One warning toast, shown instead of the plain "generated" one: the TITLE counts the warnings,
 * the DESCRIPTION lists them (plain text, one per line) because they are stored nowhere else the user can open (the
 * `SchemaVersion` keeps no warnings and the emission preview panel is not mounted). Pure, client-safe.
 */

/** At most this many warnings are listed in the toast, then `...and N more.` */
const MAX_LISTED = 5;
/** Each listed warning is cut to this many characters. */
const MAX_WARNING_LENGTH = 200;
/** Long enough to read five lines. */
export const WARNING_TOAST_DURATION_MS = 10_000;

/** The arguments of `toast.warning(title, options)`. */
export interface WarningToast {
  title: string;
  options: {
    description: string;
    duration: number;
    /** The description is plain text with line breaks: show them. */
    classNames: { description: string };
  };
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

function cut(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_WARNING_LENGTH ? `${trimmed.slice(0, MAX_WARNING_LENGTH - 1).trimEnd()}…` : trimmed;
}

/** Up to five lines, then `...and N-5 more.`; each line already carries its own prefix. */
function describe(lines: readonly string[]): string {
  const listed = lines.slice(0, MAX_LISTED);
  const rest = lines.length - listed.length;
  return (rest > 0 ? [...listed, `...and ${rest} more.`] : listed).join("\n");
}

function build(title: string, lines: readonly string[]): WarningToast {
  return { title, options: { description: describe(lines), duration: WARNING_TOAST_DURATION_MS, classNames: { description: "whitespace-pre-line" } } };
}

/** One target generated (or regenerated): `Generated with N warning(s).` + the warnings. Null when there are none (show the usual success toast). */
export function generationWarningToast(warnings: readonly string[] | undefined): WarningToast | null {
  const lines = (warnings ?? []).filter((warning) => warning.trim().length > 0).map(cut);
  if (lines.length === 0) return null;
  return build(`Generated with ${plural(lines.length, "warning")}.`, lines);
}

/**
 * A Stage Emit run (several targets, one toast): `Generated N schemas with M warning(s).` + each warning prefixed with its
 * target's label. Null when no target had any (show the usual success toast).
 */
export function stagedWarningToast(generated: number, runs: ReadonlyArray<{ label: string; warnings: readonly string[] | undefined }>): WarningToast | null {
  const lines = runs.flatMap(({ label, warnings }) =>
    (warnings ?? []).filter((warning) => warning.trim().length > 0).map((warning) => `${label}: ${cut(warning)}`)
  );
  if (lines.length === 0) return null;
  return build(`Generated ${plural(generated, "schema")} with ${plural(lines.length, "warning")}.`, lines);
}
