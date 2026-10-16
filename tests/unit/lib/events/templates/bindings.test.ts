import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BINDING_PROTOCOLS, bindingProtocolLabel, bindingTemplate, bindingVersion } from "@/lib/events/templates";
import type { BindingTarget, FieldTemplate, ObjectTemplate } from "@/lib/events/templates";
import { SPECS_ROOT } from "./spec-helpers";

const TARGETS: BindingTarget[] = ["server", "channel", "operation", "message"];
const get = (protocol: string, target: BindingTarget): ObjectTemplate => {
  const template = bindingTemplate(protocol, target);
  if (!template) throw new Error(`expected a ${protocol} ${target} binding template`);
  return template;
};
const field = (fields: FieldTemplate[], key: string) => {
  const found = fields.find((f) => f.key === key);
  if (!found) throw new Error(`no field ${key} in ${fields.map((f) => f.key).join(", ")}`);
  return found;
};
const allFields = (fields: FieldTemplate[]): FieldTemplate[] => fields.flatMap((f) => [f, ...(f.fields ? allFields(f.fields) : [])]);

/** protocol -> target -> the binding schema file with the highest version (read straight from node_modules). */
function latestSchemaFiles() {
  const out: Record<string, Partial<Record<BindingTarget, { version: string; file: string }>>> = {};
  const root = path.join(SPECS_ROOT, "bindings");
  const compare = (a: string, b: string) => {
    const [x, y] = [a, b].map((v) => v.split(".").map(Number));
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  };
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const protocol = dir.name === "websockets" ? "ws" : dir.name;
    const versions = fs.readdirSync(path.join(root, dir.name), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(compare);
    for (const version of versions) {
      for (const target of TARGETS) {
        const file = path.join(root, dir.name, version, `${target}.json`);
        if (fs.existsSync(file)) (out[protocol] ??= {})[target] = { version, file };
      }
    }
  }
  return out;
}
const LATEST = latestSchemaFiles();

describe("BINDING_PROTOCOLS", () => {
  it("contains kafka, googlepubsub and pulsar", () => {
    expect(BINDING_PROTOCOLS).toEqual(expect.arrayContaining(["kafka", "googlepubsub", "pulsar"]));
  });

  it("is every protocol that ships a binding schema, using the AsyncAPI binding key (ws for the websockets directory)", () => {
    expect([...BINDING_PROTOCOLS].sort()).toEqual(Object.keys(LATEST).sort());
    expect(BINDING_PROTOCOLS).toContain("ws");
    expect(BINDING_PROTOCOLS).not.toContain("websockets");
  });

  it("has no protocol without schemas (the amqp1, mercure, redis and stomp directories are empty placeholders)", () => {
    for (const protocol of ["amqp1", "mercure", "redis", "stomp"]) {
      expect(BINDING_PROTOCOLS).not.toContain(protocol);
      for (const target of TARGETS) expect(bindingTemplate(protocol, target)).toBeNull();
    }
  });

  it("is sorted and free of duplicates", () => {
    expect(BINDING_PROTOCOLS).toEqual([...new Set(BINDING_PROTOCOLS)].sort());
  });

  it("has a human label for every protocol", () => {
    expect(bindingProtocolLabel("kafka")).toBe("Kafka");
    expect(bindingProtocolLabel("googlepubsub")).toBe("Google Pub/Sub");
    expect(bindingProtocolLabel("pulsar")).toBe("Pulsar");
    for (const protocol of BINDING_PROTOCOLS) expect(bindingProtocolLabel(protocol).length).toBeGreaterThan(0);
    expect(bindingProtocolLabel("some-new-protocol")).toBe("Some-new-protocol");
  });
});

describe("bindingTemplate", () => {
  it("returns a template for every protocol/target pair that has a binding schema, and null for the others", () => {
    for (const protocol of BINDING_PROTOCOLS) {
      for (const target of TARGETS) {
        const template = bindingTemplate(protocol, target);
        if (LATEST[protocol]?.[target]) {
          expect(template, `${protocol} ${target}`).not.toBeNull();
          expect(template!.fields.length, `${protocol} ${target} fields`).toBeGreaterThan(0);
        } else {
          expect(template, `${protocol} ${target}`).toBeNull();
        }
      }
    }
  });

  it("returns null for an unknown protocol, including Object.prototype names", () => {
    for (const protocol of ["", "nope", "__proto__", "constructor", "toString", "KAFKA"]) {
      for (const target of TARGETS) expect(bindingTemplate(protocol, target)).toBeNull();
    }
  });

  it("identifies and labels the template", () => {
    const template = get("kafka", "channel");
    expect(template.id).toBe("binding:kafka:channel");
    expect(template.label).toBe("Kafka channel binding");
    expect(get("googlepubsub", "message").label).toBe("Google Pub/Sub message binding");
  });

  it("never lists bindingVersion (it is set automatically); bindingVersion() reports the version used", () => {
    for (const protocol of BINDING_PROTOCOLS) {
      for (const target of TARGETS) {
        const template = bindingTemplate(protocol, target);
        if (!template) {
          expect(bindingVersion(protocol, target)).toBeNull();
          continue;
        }
        expect(allFields(template.fields).map((f) => f.key)).not.toContain("bindingVersion");
        expect(bindingVersion(protocol, target)).toBe(LATEST[protocol]![target]!.version);
      }
    }
    expect(bindingVersion("kafka", "server")).toBe("0.5.0");
    expect(bindingVersion("googlepubsub", "channel")).toBe("0.2.0");
    expect(bindingVersion("pulsar", "channel")).toBe("0.1.0");
  });

  it("covers every property of every shipped binding schema (nothing is dropped)", () => {
    const missing: string[] = [];
    for (const [protocol, targets] of Object.entries(LATEST)) {
      for (const [target, entry] of Object.entries(targets)) {
        const schema = JSON.parse(fs.readFileSync(entry!.file, "utf8")) as { properties?: Record<string, unknown> };
        const keys = (bindingTemplate(protocol, target as BindingTarget)?.fields ?? []).map((f) => f.key);
        for (const property of Object.keys(schema.properties ?? {})) {
          if (property !== "bindingVersion" && !keys.includes(property)) missing.push(`${protocol}.${target}.${property}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("marks every schema-required top-level binding key as required", () => {
    const wrong: string[] = [];
    for (const [protocol, targets] of Object.entries(LATEST)) {
      for (const [target, entry] of Object.entries(targets)) {
        const schema = JSON.parse(fs.readFileSync(entry!.file, "utf8")) as { required?: string[] };
        const template = bindingTemplate(protocol, target as BindingTarget)!;
        for (const key of (schema.required ?? []).filter((k) => k !== "bindingVersion")) {
          if (!field(template.fields, key).required) wrong.push(`${protocol}.${target}.${key}`);
        }
        for (const f of template.fields) {
          if (f.required && !(schema.required ?? []).includes(f.key)) wrong.push(`${protocol}.${target}.${f.key} (extra)`);
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(field(get("jms", "server").fields, "jmsConnectionFactory").required).toBe(true);
  });

  it("keeps required keys in the basics group, and gives every field a label and a valid group", () => {
    for (const protocol of BINDING_PROTOCOLS) {
      for (const target of TARGETS) {
        const template = bindingTemplate(protocol, target);
        if (!template) continue;
        expect(template.fields.some((f) => f.group === "basics"), `${protocol} ${target} has basics`).toBe(true);
        for (const f of allFields(template.fields)) {
          expect(f.label.trim(), `${protocol}.${target}.${f.key}`).not.toBe("");
          expect(["basics", "more"]).toContain(f.group);
          if (f.required) expect(f.group, `${protocol}.${target}.${f.key}`).toBe("basics");
        }
      }
    }
  });

  describe("kafka", () => {
    it("has all four targets", () => {
      for (const target of TARGETS) expect(bindingTemplate("kafka", target)).not.toBeNull();
    });

    it("server: schema registry", () => {
      const fields = get("kafka", "server").fields;
      expect(fields.map((f) => f.key)).toEqual(["schemaRegistryUrl", "schemaRegistryVendor"]);
      expect(field(fields, "schemaRegistryUrl")).toMatchObject({ label: "Schema registry URL", kind: "text", group: "basics" });
      expect(field(fields, "schemaRegistryVendor").suggestions).toEqual(expect.arrayContaining(["confluent", "apicurio"]));
    });

    it("channel: topic, partitions, replicas and the topic configuration", () => {
      const fields = get("kafka", "channel").fields;
      expect(fields.map((f) => f.key)).toEqual(["topic", "partitions", "replicas", "topicConfiguration"]);
      expect(field(fields, "topic")).toMatchObject({ label: "Topic name", kind: "text", group: "basics" });
      expect(field(fields, "partitions")).toMatchObject({ kind: "integer", group: "basics" });
      expect(field(fields, "replicas")).toMatchObject({ kind: "integer", group: "basics" });
      const config = field(fields, "topicConfiguration");
      expect(config.kind).toBe("object");
      expect(config.fields!.map((f) => f.key)).toEqual([
        "cleanup.policy", "retention.ms", "retention.bytes", "delete.retention.ms", "max.message.bytes",
        "confluent.key.schema.validation", "confluent.key.subject.name.strategy", "confluent.value.schema.validation", "confluent.value.subject.name.strategy",
      ]);
      expect(field(config.fields!, "cleanup.policy")).toMatchObject({ kind: "stringList", suggestions: ["compact", "delete"] });
      expect(field(config.fields!, "retention.ms").kind).toBe("integer");
      expect(field(config.fields!, "confluent.key.schema.validation").kind).toBe("boolean");
      expect(field(config.fields!, "confluent.value.subject.name.strategy").group).toBe("more");
    });

    it("operation: group and client id are JSON schemas with a worked example", () => {
      const fields = get("kafka", "operation").fields;
      expect(fields.map((f) => f.key)).toEqual(["groupId", "clientId"]);
      expect(field(fields, "groupId")).toMatchObject({ label: "Consumer group ID", kind: "json", group: "basics", example: '{"type":"string","enum":["myGroupId"]}' });
    });

    it("message: key schema and schema-id handling", () => {
      const fields = get("kafka", "message").fields;
      expect(fields.map((f) => f.key)).toEqual(["key", "schemaIdLocation", "schemaIdPayloadEncoding", "schemaLookupStrategy"]);
      expect(field(fields, "key").kind).toBe("json");
      const location = field(fields, "schemaIdLocation");
      expect(location.kind).toBe("enum");
      expect(location.options!.map((o) => o.value)).toEqual(["header", "payload"]);
    });
  });

  describe("googlepubsub", () => {
    it("has channel and message bindings only", () => {
      expect(bindingTemplate("googlepubsub", "channel")).not.toBeNull();
      expect(bindingTemplate("googlepubsub", "message")).not.toBeNull();
      expect(bindingTemplate("googlepubsub", "server")).toBeNull();
      expect(bindingTemplate("googlepubsub", "operation")).toBeNull();
    });

    it("channel: schemaSettings is required with required nested encoding and name", () => {
      const fields = get("googlepubsub", "channel").fields;
      expect(fields.map((f) => f.key)).toEqual(["labels", "messageRetentionDuration", "messageStoragePolicy", "schemaSettings"]);
      const settings = field(fields, "schemaSettings");
      expect(settings).toMatchObject({ kind: "object", required: true, group: "basics" });
      expect(settings.fields!.map((f) => [f.key, f.required ?? false, f.kind])).toEqual([
        ["encoding", true, "text"], ["firstRevisionId", false, "text"], ["lastRevisionId", false, "text"], ["name", true, "text"],
      ]);
      expect(field(settings.fields!, "encoding").suggestions).toEqual(["json", "binary"]);
      expect(field(settings.fields!, "encoding").group).toBe("basics");
      expect(field(settings.fields!, "name").group).toBe("basics");
      expect(field(settings.fields!, "firstRevisionId").group).toBe("more");
      expect(field(fields, "labels").kind).toBe("keyValue");
      const policy = field(fields, "messageStoragePolicy");
      expect(policy.kind).toBe("object");
      expect(field(policy.fields!, "allowedPersistenceRegions").kind).toBe("stringList");
    });

    it("message: schema name is required inside the optional schema", () => {
      const fields = get("googlepubsub", "message").fields;
      expect(fields.map((f) => f.key)).toEqual(["attributes", "orderingKey", "schema"]);
      expect(field(fields, "attributes").kind).toBe("keyValue");
      const schema = field(fields, "schema");
      expect(schema.required).toBeUndefined();
      expect(field(schema.fields!, "name")).toMatchObject({ required: true, group: "basics" });
    });
  });

  describe("pulsar", () => {
    it("has channel and server bindings only", () => {
      expect(bindingTemplate("pulsar", "channel")).not.toBeNull();
      expect(bindingTemplate("pulsar", "server")).not.toBeNull();
      expect(bindingTemplate("pulsar", "operation")).toBeNull();
      expect(bindingTemplate("pulsar", "message")).toBeNull();
    });

    it("server: tenant", () => {
      const fields = get("pulsar", "server").fields;
      expect(fields.map((f) => f.key)).toEqual(["tenant"]);
      expect(field(fields, "tenant")).toMatchObject({ kind: "text", group: "basics" });
    });

    it("channel: namespace and persistence are required", () => {
      const fields = get("pulsar", "channel").fields;
      expect(fields.map((f) => f.key)).toEqual(["namespace", "persistence", "compaction", "geo-replication", "retention", "ttl", "deduplication"]);
      expect(field(fields, "namespace")).toMatchObject({ required: true, group: "basics", kind: "text" });
      const persistence = field(fields, "persistence");
      expect(persistence).toMatchObject({ required: true, group: "basics", kind: "enum" });
      expect(persistence.options!.map((o) => o.value)).toEqual(["persistent", "non-persistent"]);
      expect(field(fields, "compaction").kind).toBe("integer");
      expect(field(fields, "geo-replication").kind).toBe("stringList");
      expect(field(fields, "deduplication").kind).toBe("boolean");
      const retention = field(fields, "retention");
      expect(retention.kind).toBe("object");
      expect(retention.fields!.map((f) => f.key)).toEqual(["time", "size"]);
    });
  });

  describe("other protocols are humanised from their schemas", () => {
    it("amqp channel: exchange is an object with its own fields and a default vhost", () => {
      const exchange = field(get("amqp", "channel").fields, "exchange");
      expect(exchange.kind).toBe("object");
      expect(field(exchange.fields!, "autoDelete").label).toBe("Auto delete");
      expect(field(exchange.fields!, "vhost").default).toBe("/");
      expect(field(exchange.fields!, "type").options!.map((o) => o.value)).toEqual(["topic", "direct", "fanout", "default", "headers"]);
    });

    it("amqp channel: keeps the `is` choice and both branches' keys", () => {
      const fields = get("amqp", "channel").fields;
      expect(fields.map((f) => f.key)).toEqual(["is", "exchange", "queue"]);
      expect(field(fields, "is").options!.map((o) => o.value)).toEqual(["queue", "routingKey"]);
    });

    it("solace operation: destinations is a list whose items keep the queue and topic keys", () => {
      const destinations = field(get("solace", "operation").fields, "destinations");
      expect(destinations.kind).toBe("list");
      expect(destinations.fields!.map((f) => f.key)).toEqual(expect.arrayContaining(["deliveryMode", "destinationType", "queue", "topicSubscriptions"]));
    });

    it("mqtt server: an integer that may also be a schema stays an integer", () => {
      expect(field(get("mqtt", "server").fields, "sessionExpiryInterval").kind).toBe("integer");
    });

    it("sqs channel: shared definitions are expanded", () => {
      const queue = field(get("sqs", "channel").fields, "queue");
      expect(queue.kind).toBe("object");
      expect(queue.fields!.length).toBeGreaterThan(1);
    });
  });
});
