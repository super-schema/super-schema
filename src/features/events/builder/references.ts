// src/features/events/builder/references.ts
// The parts of the document a template form can point at (`FieldTemplate.refersTo`): servers, channels, messages, operations,
// traits, security schemes. Built from the draft on every render, so a form always offers what exists now. Pure — no React.
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import type { EventDocument, DocServer } from "@/lib/events/document/types";
import { isLibraryTrait } from "@/lib/events/document/types";
import type { LoadVersions, ReferenceOption, TemplateFormContext } from "./template/controls/types";

/** What a server is called in a list: its title, else its host, else its (generated) key. */
export const serverLabel = (s: Pick<DocServer, "key" | "title" | "host">): string => s.title?.trim() || s.host?.trim() || s.key;

const external = (doc: EventDocument, kind: "channel" | "message"): ReferenceOption[] =>
  doc.externalRefs.filter((r) => r.kind === kind).map((r) => ({ value: r.key, label: `${r.key} (external)` }));

/**
 * `references` has one entry for every singular target the templates use (`server`, `channel`, `message`, `operation`,
 * `securityScheme`, `messageTrait`, `operationTrait`); an empty list means "none defined yet". `entityOptions` (and an optional
 * version loader) are handed through for entity pins.
 */
export function buildReferenceContext(
  doc: EventDocument, opts: { entityOptions: EntityOption[]; loadVersions?: LoadVersions },
): TemplateFormContext {
  const traits = (kind: "MESSAGE" | "OPERATION"): ReferenceOption[] =>
    doc.traits.filter((t) => t.kind === kind).map((t) => ({ value: t.key, label: isLibraryTrait(t) ? `${t.key} (library)` : t.key }));
  const schemes = doc.components?.securitySchemes ?? {};
  return {
    references: {
      server: doc.servers.map((s) => ({ value: s.key, label: serverLabel(s) })),
      channel: [...doc.channels.map((c) => ({ value: c.key, label: c.key })), ...external(doc, "channel")],
      message: [...doc.messages.map((m) => ({ value: m.key, label: m.key })), ...external(doc, "message")],
      operation: doc.operations.map((o) => ({ value: o.key, label: o.key })),
      securityScheme: Object.entries(schemes).map(([key, scheme]) => ({ value: key, label: key, hint: scheme.type })),
      messageTrait: traits("MESSAGE"),
      operationTrait: traits("OPERATION"),
    },
    entityOptions: opts.entityOptions,
    ...(opts.loadVersions ? { loadVersions: opts.loadVersions } : {}),
  };
}
