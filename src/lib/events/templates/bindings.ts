// src/lib/events/templates/bindings.ts
// Protocol binding templates (kafka, googlepubsub, pulsar, ...): one form template per protocol and target, generated from
// the binding schemas in `@asyncapi/specs` into `bindings.generated.ts` (scripts/generate-asyncapi-templates.ts).
// Nothing here depends on the package at runtime. Pure — client-safe.
import { GENERATED_BINDINGS } from "./bindings.generated";
import type { BindingTarget, BindingTemplateId, ObjectTemplate } from "./types";

/** Every protocol that ships a binding schema, as the key used in an AsyncAPI `bindings` object (`ws`, not `websockets`). Sorted. */
export const BINDING_PROTOCOLS: string[] = Object.keys(GENERATED_BINDINGS);

const PROTOCOL_LABELS: Record<string, string> = {
  amqp: "AMQP", amqp1: "AMQP 1.0", anypointmq: "Anypoint MQ", googlepubsub: "Google Pub/Sub", http: "HTTP", ibmmq: "IBM MQ", jms: "JMS",
  kafka: "Kafka", mercure: "Mercure", mqtt: "MQTT", nats: "NATS", pulsar: "Pulsar", redis: "Redis", ros2: "ROS 2", sns: "Amazon SNS",
  solace: "Solace", sqs: "Amazon SQS", stomp: "STOMP", ws: "WebSocket",
};

/** "Kafka", "Google Pub/Sub", ...; an unknown protocol is shown as written, capitalised. */
export function bindingProtocolLabel(protocol: string): string {
  return Object.hasOwn(PROTOCOL_LABELS, protocol) ? PROTOCOL_LABELS[protocol] : protocol.charAt(0).toUpperCase() + protocol.slice(1);
}

function entryFor(protocol: string, target: BindingTarget) {
  if (!Object.hasOwn(GENERATED_BINDINGS, protocol)) return undefined;
  const targets = GENERATED_BINDINGS[protocol];
  return Object.hasOwn(targets, target) ? targets[target] : undefined;
}

const cache = new Map<string, ObjectTemplate>();

/**
 * The form template for a protocol's binding on a server, channel, operation or message; `null` when the protocol has no
 * binding for that target (Google Pub/Sub has no server binding, for example) or is unknown.
 * `bindingVersion` is not a field: it is set automatically (see `bindingVersion`). Required binding keys are `required: true`.
 */
export function bindingTemplate(protocol: string, target: BindingTarget): ObjectTemplate | null {
  const entry = entryFor(protocol, target);
  if (!entry) return null;
  const id: BindingTemplateId = `binding:${protocol}:${target}`;
  let template = cache.get(id);
  if (!template) {
    template = { id, label: `${bindingProtocolLabel(protocol)} ${target} binding`, fields: entry.fields };
    cache.set(id, template);
  }
  return template;
}

/** The binding schema version a template was generated from (the highest the package ships), or `null` when there is none. */
export function bindingVersion(protocol: string, target: BindingTarget): string | null {
  return entryFor(protocol, target)?.version ?? null;
}
