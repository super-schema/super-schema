// src/lib/events/publish-blockers.ts
// What the Publish dialog shows of an event's blockers. Pure — client-safe.
import type { EventPublishAnalysis, EventPublishBlocker } from "@/lib/events/publish-plan";

/**
 * One row per distinct message. One root cause reaches the planner several times: a pin to a missing entity version is a facts
 * blocker at its draft pointer AND an emission blocker at one or two pointers of the generated AsyncAPI, all with the same text.
 * A pointer may therefore name the draft or the emitted document, so the folded rows carry none: the dialog shows the message,
 * never a path into one particular document. The first blocker of a message decides the kind; the order is that of first
 * appearance. The input is not changed.
 */
export function foldPublishBlockers(analysis: EventPublishAnalysis): EventPublishAnalysis {
  const seen = new Set<string>();
  const blockers: EventPublishBlocker[] = [];
  for (const { kind, message } of analysis.blockers) {
    if (seen.has(message)) continue;
    seen.add(message);
    blockers.push({ kind, message });
  }
  return { ...analysis, blockers };
}
