// src/lib/events/publish-blockers.ts
// What the Publish dialog shows of an event's blockers. Pure — client-safe.
import type { EventPublishAnalysis } from "@/lib/events/publish-plan";

/** One row per distinct message; the first blocker of a message decides its kind and the order is that of first appearance. */
function foldByMessage<K extends string>(blockers: ReadonlyArray<{ kind: K; message: string }>): Array<{ kind: K; message: string }> {
  const seen = new Set<string>();
  const rows: Array<{ kind: K; message: string }> = [];
  for (const { kind, message } of blockers) {
    if (seen.has(message)) continue;
    seen.add(message);
    rows.push({ kind, message });
  }
  return rows;
}

/**
 * One row per distinct message. One root cause reaches the planner several times: a pin to a missing entity version is a facts
 * blocker at its draft pointer AND an emission blocker at one or two pointers of the generated AsyncAPI, all with the same text.
 * A pointer may therefore name the draft or the emitted document, so the folded rows carry none: the dialog shows the message,
 * never a path into one particular document. The first blocker of a message decides the kind; the order is that of first
 * appearance. The input is not changed.
 */
export function foldPublishBlockers(analysis: EventPublishAnalysis): EventPublishAnalysis {
  return { ...analysis, blockers: foldByMessage(analysis.blockers) };
}

/**
 * The blockers of a REFUSED publish (the plan changed between the dialog's preview and its confirm), folded like the preview's, for
 * the dialog to list under its error. Only `PUBLISH_BLOCKED` carries them: the `details` of any other code are never read here, and
 * an answer without a usable list (missing, malformed, entries without text) gives none, so the caller falls back to the one-line
 * message. `details` comes over the wire: nothing in it is trusted beyond its `message` and `kind` strings.
 */
export function blockersOfFailedPublish(failure: { code?: string; details?: object }): Array<{ kind: string; message: string }> {
  if (failure.code !== "PUBLISH_BLOCKED") return [];
  const listed = (failure.details as { blockers?: unknown } | undefined)?.blockers;
  if (!Array.isArray(listed)) return [];
  const rows: Array<{ kind: string; message: string }> = [];
  for (const entry of listed as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { kind, message } = entry as { kind?: unknown; message?: unknown };
    if (typeof message !== "string" || message.trim() === "") continue;
    rows.push({ kind: typeof kind === "string" ? kind : "BLOCKER", message });
  }
  return foldByMessage(rows);
}
