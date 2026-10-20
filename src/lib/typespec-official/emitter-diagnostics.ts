/**
 * emitter-diagnostics.ts — what a failed `tsp compile` says, as a message a user can read.
 *
 * `execFile` rejects with the compiler's whole stdout/stderr: a banner, the diagnostics with their ABSOLUTE temp-workspace
 * paths (`/var/folders/.../superschema-tsp-x/main.tsp:8:7 - error ...`), a count and the progress lines. Only the error
 * diagnostics are the answer, and the workspace is a throw-away directory the user never sees. Pure function.
 */

/** `<path>/main.tsp:8:7 - error <code>: <message>`, or a location-less `error <code>: <message>`. */
const ERROR_DIAGNOSTIC = /^(?:.*?\.tsp:\d+:\d+ - )?error (\S+: .+)$/gm;

/** Temp-workspace paths: absolute multi-segment paths, `../` chains up to them, and the workspace directory name. */
const WORKSPACE_PATH = /(?:\.\.\/)+(?:[\w.@+~-]+\/)*[\w.@+~-]+|(?<![\w#:.@-])\/(?:[\w.@+~-]+\/){2,}[\w.@+~-]*|superschema-tsp-[\w-]+/g;

const MAX_DIAGNOSTICS = 5;
const MAX_FALLBACK_LENGTH = 400;

const scrubPaths = (text: string): string => text.replace(WORKSPACE_PATH, "<path>");

/** The error diagnostics of a failed compile (at most five, then a count of the rest); else the text with its paths removed. */
export function describeEmitterFailure(raw: string): string {
  const diagnostics = [...raw.matchAll(ERROR_DIAGNOSTIC)].map((match) => scrubPaths(match[1]).trim());
  if (diagnostics.length > 0) {
    const shown = diagnostics.slice(0, MAX_DIAGNOSTICS);
    const rest = diagnostics.length - shown.length;
    return (rest > 0 ? [...shown, `(and ${rest} more)`] : shown).join("\n");
  }
  return scrubPaths(raw).trim().slice(0, MAX_FALLBACK_LENGTH) || "The TypeSpec emitter failed.";
}
