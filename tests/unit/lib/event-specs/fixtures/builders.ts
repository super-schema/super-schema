/** Small builders for per-concern assembler tests. */
import type {
  ResolvedChannel,
  ResolvedEventSpec,
  ResolvedMessage,
  ResolvedOperation,
  SchemaArtifact,
} from "@/lib/event-specs/types";

export function avroRecord(name: string): SchemaArtifact {
  return { format: "avro", schema: { type: "record", name, namespace: "acme.test", fields: [] } };
}

export function jsonObject(title: string, dialect: "draft-07" | "2020-12" = "draft-07"): SchemaArtifact {
  return { format: "json-schema", dialect, schema: { title, type: "object", properties: {} } };
}

export function channel(overrides: Partial<ResolvedChannel> & Pick<ResolvedChannel, "id" | "name">): ResolvedChannel {
  return {
    productSlug: "checkout",
    address: `${overrides.name}.v1`,
    protocol: "kafka",
    profile: { format: "avro" },
    ...overrides,
  };
}

export function message(overrides: Partial<ResolvedMessage> & Pick<ResolvedMessage, "id" | "name">): ResolvedMessage {
  return {
    productSlug: "checkout",
    traitRefs: [],
    payloads: [avroRecord(overrides.name), jsonObject(overrides.name)],
    ...overrides,
  };
}

export function operation(
  overrides: Partial<ResolvedOperation> & Pick<ResolvedOperation, "key" | "channelRef" | "messageRefs">,
): ResolvedOperation {
  return { action: "send", traitRefs: [], ...overrides };
}

export function spec(overrides: Partial<ResolvedEventSpec>): ResolvedEventSpec {
  return {
    productSlug: "checkout",
    info: { title: "test-spec", version: "1.0" },
    servers: [],
    operations: [],
    channels: [],
    messages: [],
    traits: [],
    components: {},
    ...overrides,
  };
}

/** Recursively freeze so any mutation of assembler input throws (ES modules are strict). */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
