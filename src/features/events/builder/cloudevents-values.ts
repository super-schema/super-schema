// src/features/events/builder/cloudevents-values.ts
// What each CloudEvents context attribute is for ONE message of this event: the fixed value the spec mandates, the value derived from
// the event (its product, the message's representation and pinned payload), or an example where only the producer knows it at runtime.
import { contentTypeFor } from "@/lib/event-specs/schema-format";
import { resolveRepresentations } from "@/lib/events/document/representation";
import type { DocMessage, EventDocument } from "@/lib/events/document/types";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import type { BuilderScope } from "./EventBuilder";

/** `fixed`: mandated by the spec · `derived`: follows from this event's definition · `example`: set by the producer per event. */
export type PropertyValueKind = "fixed" | "derived" | "example";
export interface PropertyValue {
  value: string; kind: PropertyValueKind; note?: string;
  /** Editable for the whole event: `default` is what an empty input falls back to (the placeholder). */
  editable?: { default: string };
}

const segment = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function cloudEventsValues(input: {
  doc: EventDocument; message: DocMessage; entityOptions: readonly EntityOption[]; scope?: BuilderScope;
  /** The app's origin (`https://schemas.example.com`), for an absolute `dataschema`; absent on the server. */
  origin?: string;
  /** A fixed time and id keep examples stable (tests); defaults to now and a fixed sample. */
  now?: Date;
}): Record<string, PropertyValue> {
  const { doc, message, entityOptions, scope } = input;
  const messageName = message.name?.trim() || message.key;
  const out: Record<string, PropertyValue> = {
    specversion: { value: "1.0", kind: "fixed" },
    id: { value: "3f9c2a7e-6b1d-4e8a-9c3f-2d5b7a1e0c48", kind: "example", note: "Unique per event (with source); typically a UUID." },
    time: { value: (input.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"), kind: "example", note: "When the occurrence happened." },
  };
  if (scope) out.type = { value: [scope.tenantSlug, scope.domainSlug, scope.productSlug, segment(messageName)].map(segment).filter(Boolean).join("."), kind: "derived", note: "tenant.domain.product.message" };
  const derivedSource = scope ? `/${[scope.tenantSlug, scope.domainSlug, scope.productSlug].map(segment).join("/")}` : "";
  const setSource = doc.cloudEventsSource?.trim();
  out.source = {
    value: setSource || derivedSource, kind: "derived", editable: { default: derivedSource },
    note: setSource ? "Set for every message of this event." : "Defaults to the producing product; set the emitting app or another context.",
  };
  const key = message.keyPin?.entityId ? entityOptions.find((e) => e.id === message.keyPin!.entityId) : undefined;
  out.subject = { value: key ? `<${key.name} key>` : "<record id>", kind: "example", note: key ? `The message key (${key.name}) of the event.` : "What the event is about, e.g. the record id." };

  const formats = new Map(entityOptions.map((e) => [e.id, e.sourceFormat]));
  const effective = resolveRepresentations(doc, formats).get(message.key);
  const contentType = message.contentType?.trim() || doc.defaultContentType?.trim() || (effective ? contentTypeFor({ format: effective.format, dialect: effective.dialect }) : undefined);
  if (contentType) {
    out.datacontenttype = {
      value: contentType, kind: "derived",
      note: message.contentType?.trim() ? "The message's content type." : doc.defaultContentType?.trim() ? "The event's default content type." : `From the ${effective?.format === "json-schema" ? "JSON Schema" : effective?.format === "avro" ? "Avro" : "Protobuf"} representation.`,
    };
  }

  const payload = message.payload.entityId ? entityOptions.find((e) => e.id === message.payload.entityId) : undefined;
  if (payload?.href) {
    const pinned = message.payload.entityVersionId;
    const label = pinned && pinned === payload.latestVersionId ? payload.latestVersionLabel : null;
    const path = `${payload.href}${label ? `?version=${encodeURIComponent(label)}` : ""}`;
    out.dataschema = {
      value: input.origin ? `${input.origin}${path}` : path, kind: "derived",
      note: !pinned ? `${payload.name} is not pinned; pin a published version for a stable link.` : label ? `${payload.name} v${label}.` : `${payload.name}, pinned version.`,
    };
  } else {
    out.dataschema = { value: "—", kind: "derived", note: "Choose the payload entity to get its schema link." };
  }
  return out;
}
