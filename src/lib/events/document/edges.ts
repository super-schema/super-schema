// src/lib/events/document/edges.ts
// Reference edges and reference lists collected from an event document (spec 2026-10-15-events-self-contained-design §6). Pure — client-safe.
import { isLibraryTrait, type EventDocument } from "./types";
import type { EntityPin } from "@/lib/events/types";

export interface DocumentEdge { role: "PAYLOAD" | "HEADERS" | "KEY" | "MESSAGE"; toKind: "ENTITY_VERSION" | "EVENT_SPEC_VERSION"; toId: string }
export interface DocumentRefs { entityIds: string[]; pinnedVersionIds: string[]; unpinned: Array<{ pointer: string; entityId: string }>; libraryTraitIds: string[]; externalVersionIds: string[] }

type PinSite = { pointer: string; role: "PAYLOAD" | "HEADERS" | "KEY"; pin: EntityPin };

function pinSites(doc: EventDocument): PinSite[] {
  const sites: PinSite[] = [];
  doc.messages.forEach((m, i) => {
    sites.push({ pointer: `/messages/${i}/payload`, role: "PAYLOAD", pin: m.payload });
    if (m.headers) sites.push({ pointer: `/messages/${i}/headers`, role: "HEADERS", pin: m.headers });
    if (m.keyPin) sites.push({ pointer: `/messages/${i}/keyPin`, role: "KEY", pin: m.keyPin });
  });
  doc.traits.forEach((t, i) => {
    if (!isLibraryTrait(t) && t.headers) sites.push({ pointer: `/traits/${i}/headers`, role: "HEADERS", pin: t.headers });
  });
  return sites;
}

/** UTF-16 code-unit order: locale-independent, so edge order is stable across environments. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const uniqueSorted = (xs: string[]) => [...new Set(xs)].sort(compare);

export function collectDocumentEdges(doc: EventDocument): DocumentEdge[] {
  const edges = new Map<string, DocumentEdge>();
  const add = (e: DocumentEdge) => edges.set(`${e.role}|${e.toKind}|${e.toId}`, e);
  for (const s of pinSites(doc)) if (s.pin.entityVersionId) add({ role: s.role, toKind: "ENTITY_VERSION", toId: s.pin.entityVersionId });
  for (const r of doc.externalRefs) add({ role: "MESSAGE", toKind: "EVENT_SPEC_VERSION", toId: r.eventVersionId });
  return [...edges.values()].sort((a, b) => compare(a.role, b.role) || compare(a.toKind, b.toKind) || compare(a.toId, b.toId));
}

export function collectDocumentRefs(doc: EventDocument): DocumentRefs {
  const sites = pinSites(doc);
  return {
    entityIds: uniqueSorted(sites.map((s) => s.pin.entityId)),
    pinnedVersionIds: uniqueSorted(sites.flatMap((s) => (s.pin.entityVersionId ? [s.pin.entityVersionId] : []))),
    unpinned: sites.filter((s) => !s.pin.entityVersionId).map((s) => ({ pointer: s.pointer, entityId: s.pin.entityId })),
    libraryTraitIds: uniqueSorted(doc.traits.flatMap((t) => (isLibraryTrait(t) ? [t.libraryTraitId] : []))),
    externalVersionIds: uniqueSorted(doc.externalRefs.map((r) => r.eventVersionId)),
  };
}
