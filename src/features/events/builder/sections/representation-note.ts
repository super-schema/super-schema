// src/features/events/builder/sections/representation-note.ts
// The sentence under a message's "Payload representation" select (round-2 R4): what Auto resolved to and why, or what the user chose.
// It asks the same resolver the server uses (`resolveRepresentations`), so the builder never says something the emitted document will
// not do. Pure — no React.
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import { describeRepresentation, resolveRepresentations } from "@/lib/events/document/representation";
import type { EventDocument } from "@/lib/events/document/types";

/** `auto` = what Auto resolved to; `explicit` = the user's own choice; `hint` = nothing can be said yet. */
export interface RepresentationNote { tone: "auto" | "explicit" | "hint"; text: string }

const NEEDS_PAYLOAD = "Choose the payload entity first. Auto then follows the format the entity was imported from, or the protocol of the channel.";

/** The resolver's reason as the tail of a sentence: "Auto: Kafka channels default to Avro" -> "Kafka channels default to Avro". */
function clause(reason: string): string {
  if (reason.startsWith("Auto: ")) return reason.slice("Auto: ".length);
  return reason.charAt(0).toLowerCase() + reason.slice(1);
}

/** The note for message `messageKey` of `doc`; `entityOptions` carry each entity's name and recorded source format. */
export function representationNote(doc: EventDocument, messageKey: string, entityOptions: readonly EntityOption[]): RepresentationNote {
  const message = doc.messages.find((m) => m.key === messageKey);
  if (!message) return { tone: "hint", text: NEEDS_PAYLOAD };
  if (!message.representation && !message.payload.entityId) return { tone: "hint", text: NEEDS_PAYLOAD };

  const entityFormats = new Map(entityOptions.map((e) => [e.id, e.sourceFormat]));
  const entityLabels = new Map(entityOptions.map((e) => [e.id, e.name]));
  const effective = resolveRepresentations(doc, entityFormats, { entityLabels }).get(message.key);
  if (!effective) return { tone: "hint", text: NEEDS_PAYLOAD };

  const described = describeRepresentation(effective);
  if (message.representation) return { tone: "explicit", text: `Chosen on this message: ${described}` };
  return { tone: "auto", text: `Auto → ${described} — ${clause(effective.reason)}` };
}
