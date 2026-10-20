/**
 * emitter-diagnostics.ts — what a `tsp compile` says, as a message a user can read.
 *
 * `execFile` rejects with the compiler's whole stdout/stderr: a banner, the diagnostics with their ABSOLUTE temp-workspace
 * paths (`/var/folders/.../superschema-tsp-x/main.tsp:8:7 - error ...`), a count and the progress lines — and, when an
 * emitter CRASHES (`$onEmit` throws), the banner, `Emitter "x" crashed!` and a stack trace full of file:// URLs and install
 * paths. Only the diagnostics are the answer. A failure with NO error diagnostic is never shown as text: the Schemas tab gets
 * {@link GENERIC_EMITTER_FAILURE} and the caller logs the raw text server-side. Pure functions.
 */

/** The text a user sees for a failure that has no error diagnostic (an emitter crash, a missing binary, a full disk, ...). */
export const GENERIC_EMITTER_FAILURE = "The TypeSpec emitter failed.";

/**
 * Absolute multi-segment filesystem paths (temp workspaces), `../` chains up to them, and the workspace directory name.
 * `src/services/events/event-snapshot.ts` keeps its own copy of the first and last alternatives; it can import this one.
 */
export const FILE_PATH = /(?:\.\.\/)+(?:[\w.@+~-]+\/)*[\w.@+~-]+|(?<![\w#:.@-])\/(?:[\w.@+~-]+\/){2,}[\w.@+~-]*|superschema-tsp-[\w-]+/g;

/** `<path>/main.tsp:8:7 - error <code>: <message>`, or a location-less `error <code>: <message>`. */
const ERROR_DIAGNOSTIC = /^(?:.*?\.tsp:\d+:\d+ - )?error (\S+: .+)$/gm;
/** The same for warnings. */
const WARNING_DIAGNOSTIC = /^(?:.*?\.tsp:\d+:\d+ - )?warning (\S+: .+)$/gm;

const MAX_DIAGNOSTICS = 5;

const scrubPaths = (text: string): string => text.replace(FILE_PATH, "<path>");

function diagnosticsOf(raw: string, pattern: RegExp): string[] {
  return [...raw.matchAll(pattern)].map((match) => scrubPaths(match[1]).trim());
}

/** The error diagnostics of a compile (`<code>: <message>`, paths removed); empty for a crash or any non-compile failure. */
export function errorDiagnostics(raw: string): string[] {
  return diagnosticsOf(raw, ERROR_DIAGNOSTIC);
}

/** The warning diagnostics of a compile, same shape as {@link errorDiagnostics}. */
export function warningDiagnostics(raw: string): string[] {
  return diagnosticsOf(raw, WARNING_DIAGNOSTIC);
}

/** The error diagnostics of a failed compile (at most five, then a count of the rest); {@link GENERIC_EMITTER_FAILURE} when there is none. */
export function describeEmitterFailure(raw: string): string {
  const diagnostics = errorDiagnostics(raw);
  if (diagnostics.length === 0) return GENERIC_EMITTER_FAILURE;
  const shown = diagnostics.slice(0, MAX_DIAGNOSTICS);
  const rest = diagnostics.length - shown.length;
  return (rest > 0 ? [...shown, `(and ${rest} more)`] : shown).join("\n");
}
