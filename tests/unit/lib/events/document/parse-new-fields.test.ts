// tests/unit/lib/events/document/parse-new-fields.test.ts
// WP-1a: the parser validates every AsyncAPI 3.0 property the document model gained (info, server, channel, message,
// operation, reply, local traits, components.securitySchemes). Each field: a valid case and every invalid case with its pointer.
import { describe, expect, it } from "vitest";
import { parseEventDocument } from "@/lib/events/document/parse";
import type { DocComponents, EventDocument } from "@/lib/events/document/types";
import { slice1Minimal } from "./fixtures/slice1-documents";

type Problem = { pointer: string; message: string };

/** Writes a field the types forbid (a wrong-typed value, an unknown property) so the parser can be shown rejecting it. */
const loose = (value: object): Record<string, unknown> => value as unknown as Record<string, unknown>;

function problemsOf(value: unknown): Problem[] {
  const r = parseEventDocument(value);
  return r.success ? [] : (r.error.details as { problems: Problem[] }).problems;
}
const pointersOf = (value: unknown): string[] => problemsOf(value).map((p) => p.pointer);
function parsed(value: unknown): EventDocument {
  const r = parseEventDocument(value);
  if (!r.success) throw new Error(`expected the document to parse, got ${JSON.stringify(r.error.details)}`);
  return r.data;
}
/** A slice-1 document plus a local operation trait and a local message trait, mutated by `fn`. */
function mutate(fn: (d: EventDocument) => void): EventDocument {
  const d = slice1Minimal();
  d.traits.push({ key: "Envelope", kind: "MESSAGE", spec: {} }, { key: "Audited", kind: "OPERATION", spec: {} });
  fn(d);
  return d;
}
const withSchemes = (schemes: DocComponents["securitySchemes"]) => (d: EventDocument) => { d.components = { securitySchemes: schemes }; };

describe("info", () => {
  it("accepts and returns every info property", () => {
    const info = {
      title: "checkout-service", description: "d", termsOfService: "https://example.com/terms",
      contact: { name: "Platform", url: "https://example.com/support", email: "platform@example.com" },
      license: { name: "Apache 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0.html" },
      tags: [{ name: "payments", description: "Payments", externalDocs: { url: "https://example.com/payments", description: "More" } }, { name: "core" }],
      externalDocs: { url: "https://example.com/docs", description: "Docs" },
    };
    expect(parsed(mutate((d) => { d.info = info; })).info).toEqual(info);
  });

  describe("termsOfService", () => {
    it.each(["not a url", "ftp://example.com/terms", "mailto:legal@example.com", "/terms", "https://", "https://exa mple.com"])("rejects %j", (value) => {
      expect(pointersOf(mutate((d) => { d.info.termsOfService = value; }))).toEqual(["/info/termsOfService"]);
    });
    it("rejects a non-string", () => {
      expect(pointersOf(mutate((d) => { loose(d.info).termsOfService = 5; }))).toEqual(["/info/termsOfService"]);
    });
    it("accepts http and https and drops a blank value", () => {
      expect(parsed(mutate((d) => { d.info.termsOfService = " http://example.com/t "; })).info.termsOfService).toBe("http://example.com/t");
      expect(parsed(mutate((d) => { d.info.termsOfService = "   "; })).info).not.toHaveProperty("termsOfService");
    });
  });

  describe("contact", () => {
    it("rejects an invalid url and an invalid email, each at its own pointer", () => {
      expect(pointersOf(mutate((d) => { d.info.contact = { url: "support" }; }))).toEqual(["/info/contact/url"]);
      expect(pointersOf(mutate((d) => { d.info.contact = { email: "nobody" }; }))).toEqual(["/info/contact/email"]);
      expect(pointersOf(mutate((d) => { d.info.contact = { email: "a b@example.com" }; }))).toEqual(["/info/contact/email"]);
    });
    it("rejects a non-object and unknown properties, but keeps x- extensions", () => {
      expect(pointersOf(mutate((d) => { loose(d.info).contact = "me"; }))).toEqual(["/info/contact"]);
      expect(pointersOf(mutate((d) => { loose(d.info).contact = { name: "n", phone: "1" }; }))).toEqual(["/info/contact/phone"]);
      const kept = parsed(mutate((d) => { loose(d.info).contact = { name: "n", "x-slack": "#platform" }; }));
      expect(kept.info.contact).toEqual({ name: "n", "x-slack": "#platform" });
    });
    it("drops blank members and an empty contact stays an empty object", () => {
      expect(parsed(mutate((d) => { d.info.contact = { name: "  ", email: "a@b.co" }; })).info.contact).toEqual({ email: "a@b.co" });
    });
  });

  describe("license", () => {
    it("requires a name", () => {
      expect(pointersOf(mutate((d) => { loose(d.info).license = { url: "https://example.com/l" }; }))).toEqual(["/info/license/name"]);
      expect(pointersOf(mutate((d) => { loose(d.info).license = { name: "  " }; }))).toEqual(["/info/license/name"]);
    });
    it("rejects an invalid url and a non-object", () => {
      expect(pointersOf(mutate((d) => { d.info.license = { name: "MIT", url: "mit" }; }))).toEqual(["/info/license/url"]);
      expect(pointersOf(mutate((d) => { loose(d.info).license = ["MIT"]; }))).toEqual(["/info/license"]);
    });
  });

  describe("tags", () => {
    it("requires a non-empty name on every entry", () => {
      expect(pointersOf(mutate((d) => { loose(d.info).tags = [{ name: "ok" }, { description: "no name" }, { name: "  " }]; })))
        .toEqual(["/info/tags/1/name", "/info/tags/2/name"]);
    });
    it("rejects a non-array, a non-object entry and a tag whose externalDocs has no url", () => {
      expect(pointersOf(mutate((d) => { loose(d.info).tags = { name: "x" }; }))).toEqual(["/info/tags"]);
      expect(pointersOf(mutate((d) => { loose(d.info).tags = [{ name: "a" }, "b"]; }))).toEqual(["/info/tags/1"]);
      expect(pointersOf(mutate((d) => { loose(d.info).tags = [{ name: "a", externalDocs: { description: "d" } }]; })))
        .toEqual(["/info/tags/0/externalDocs/url"]);
    });
    it("rejects unknown tag properties", () => {
      expect(pointersOf(mutate((d) => { loose(d.info).tags = [{ name: "a", color: "red" }]; }))).toEqual(["/info/tags/0/color"]);
    });
    it("keeps the authored order of the list", () => {
      expect(parsed(mutate((d) => { d.info.tags = [{ name: "b" }, { name: "a" }, { name: "c" }]; })).info.tags?.map((t) => t.name)).toEqual(["b", "a", "c"]);
    });
  });

  describe("externalDocs", () => {
    it("requires a valid url", () => {
      expect(pointersOf(mutate((d) => { loose(d.info).externalDocs = { description: "d" }; }))).toEqual(["/info/externalDocs/url"]);
      expect(pointersOf(mutate((d) => { d.info.externalDocs = { url: "docs" }; }))).toEqual(["/info/externalDocs/url"]);
      expect(pointersOf(mutate((d) => { loose(d.info).externalDocs = "https://example.com"; }))).toEqual(["/info/externalDocs"]);
    });
    it("rejects a non-string description", () => {
      expect(pointersOf(mutate((d) => { loose(d.info).externalDocs = { url: "https://example.com", description: 4 }; })))
        .toEqual(["/info/externalDocs/description"]);
    });
  });
});

describe("servers", () => {
  it("accepts and returns every server property", () => {
    const server = {
      key: "kafka-prod", protocol: "kafka", host: "{env}.kafka.internal:9092", pathname: "/{region}", protocolVersion: "3.7", description: "Prod",
      title: "Kafka (prod)", summary: "The production cluster",
      variables: { env: { enum: ["prod", "stage"], default: "prod", description: "Environment", examples: ["prod"] }, region: { default: "eu" } },
      security: ["basic", "token"],
      tags: [{ name: "prod", description: "Production", externalDocs: { url: "https://example.com/prod" } }],
      externalDocs: { url: "https://example.com/kafka", description: "Runbook" },
      bindings: { kafka: { schemaRegistryUrl: "https://registry.example.com", schemaRegistryVendor: "confluent" } },
    };
    const d = mutate((x) => {
      x.servers = [server];
      x.components = { securitySchemes: { basic: { type: "userPassword" }, token: { type: "http", scheme: "bearer" } } };
    });
    expect(parsed(d).servers[0]).toEqual(server);
  });

  it("rejects non-string title and summary and a non-object bindings", () => {
    expect(pointersOf(mutate((d) => { loose(d.servers[0]).title = 1; }))).toEqual(["/servers/0/title"]);
    expect(pointersOf(mutate((d) => { loose(d.servers[0]).summary = true; }))).toEqual(["/servers/0/summary"]);
    expect(pointersOf(mutate((d) => { loose(d.servers[0]).bindings = "kafka"; }))).toEqual(["/servers/0/bindings"]);
  });

  it("validates tags and externalDocs like the info ones", () => {
    expect(pointersOf(mutate((d) => { loose(d.servers[0]).tags = [{ description: "x" }]; }))).toEqual(["/servers/0/tags/0/name"]);
    expect(pointersOf(mutate((d) => { loose(d.servers[0]).externalDocs = { url: "ftp://x.org" }; }))).toEqual(["/servers/0/externalDocs/url"]);
  });

  describe("variables", () => {
    it("accepts a variable used in the host, in the pathname, or in both", () => {
      expect(pointersOf(mutate((d) => { d.servers[0] = { ...d.servers[0], host: "{h}.example.com:9092", variables: { h: {} } }; }))).toEqual([]);
      expect(pointersOf(mutate((d) => { d.servers[0] = { ...d.servers[0], pathname: "/{p}", variables: { p: {} } }; }))).toEqual([]);
      expect(pointersOf(mutate((d) => { d.servers[0] = { ...d.servers[0], host: "{a}.x:1", pathname: "/{a}/{b}", variables: { a: {}, b: {} } }; }))).toEqual([]);
    });
    it("reports a variable that appears in neither the host nor the pathname, at the variable", () => {
      const p = problemsOf(mutate((d) => { d.servers[0] = { ...d.servers[0], variables: { env: { default: "prod" } } }; }));
      expect(p.map((x) => x.pointer)).toEqual(["/servers/0/variables/env"]);
      expect(p[0].message).toContain("{env}");
    });
    it("matches the whole {name}, not a prefix of it", () => {
      expect(pointersOf(mutate((d) => { d.servers[0] = { ...d.servers[0], host: "{environment}.x:1", variables: { env: {} } }; }))).toEqual(["/servers/0/variables/env"]);
    });
    it("escapes the variable name in the pointer", () => {
      expect(pointersOf(mutate((d) => { d.servers[0] = { ...d.servers[0], variables: { "a/b": {} } }; }))).toEqual(["/servers/0/variables/a~1b"]);
    });
    it("rejects a non-object variables map and a non-object variable", () => {
      expect(pointersOf(mutate((d) => { loose(d.servers[0]).variables = [{ env: {} }]; }))).toEqual(["/servers/0/variables"]);
      expect(pointersOf(mutate((d) => { d.servers[0] = { ...d.servers[0], host: "{env}.x:1", variables: { env: "prod" } as never }; }))).toEqual(["/servers/0/variables/env"]);
    });
    it("validates enum, default, description and examples", () => {
      const host = (variables: unknown) => mutate((d) => { d.servers[0] = { ...d.servers[0], host: "{env}.x:1", variables: variables as never }; });
      expect(pointersOf(host({ env: { enum: "prod" } }))).toEqual(["/servers/0/variables/env/enum"]);
      expect(pointersOf(host({ env: { enum: ["prod", 3] } }))).toEqual(["/servers/0/variables/env/enum/1"]);
      expect(pointersOf(host({ env: { enum: ["prod", "prod"] } }))).toEqual(["/servers/0/variables/env/enum/1"]);
      expect(pointersOf(host({ env: { default: 3 } }))).toEqual(["/servers/0/variables/env/default"]);
      expect(pointersOf(host({ env: { description: 3 } }))).toEqual(["/servers/0/variables/env/description"]);
      expect(pointersOf(host({ env: { examples: ["a", ""] } }))).toEqual(["/servers/0/variables/env/examples/1"]);
      expect(pointersOf(host({ env: { values: ["a"] } }))).toEqual(["/servers/0/variables/env/values"]);
    });
    it("keeps the authored order of the variables and of each variable's keys", () => {
      const d = mutate((x) => { x.servers[0] = { ...x.servers[0], host: "{z}.{a}:1", variables: { z: { description: "d", default: "1" }, a: { default: "2", description: "d" } } }; });
      const server = parsed(d).servers[0];
      expect(Object.keys(server.variables ?? {})).toEqual(["z", "a"]);
      expect(Object.keys(server.variables?.z ?? {})).toEqual(["description", "default"]);
      expect(Object.keys(server.variables?.a ?? {})).toEqual(["default", "description"]);
    });
  });

  describe("security", () => {
    const schemes = { basic: { type: "userPassword" as const } };
    it("accepts keys of components.securitySchemes", () => {
      expect(pointersOf(mutate((d) => { withSchemes(schemes)(d); d.servers[0].security = ["basic"]; }))).toEqual([]);
    });
    it("reports a key that is not a security scheme, at its position", () => {
      const p = problemsOf(mutate((d) => { withSchemes(schemes)(d); d.servers[0].security = ["basic", "ghost"]; }));
      expect(p.map((x) => x.pointer)).toEqual(["/servers/0/security/1"]);
      expect(p[0].message).toContain("ghost");
    });
    it("reports every key when the document defines no security schemes", () => {
      expect(pointersOf(mutate((d) => { d.servers[0].security = ["a", "b"]; }))).toEqual(["/servers/0/security/0", "/servers/0/security/1"]);
    });
    it("rejects a non-array and non-string entries", () => {
      expect(pointersOf(mutate((d) => { loose(d.servers[0]).security = "basic"; }))).toEqual(["/servers/0/security"]);
      expect(pointersOf(mutate((d) => { withSchemes(schemes)(d); loose(d.servers[0]).security = ["basic", 4]; }))).toEqual(["/servers/0/security/1"]);
    });
    it("does not pile an unknown-scheme problem on top of a malformed securitySchemes map", () => {
      const p = pointersOf(mutate((d) => { (d as { components?: unknown }).components = { securitySchemes: "oops" }; d.servers[0].security = ["basic"]; }));
      expect(p).toEqual(["/components/securitySchemes"]);
    });
  });
});

describe("channels", () => {
  const withParameters = (parameters: unknown, address = "orders.{tenantId}") =>
    mutate((d) => { d.channels[0] = { ...d.channels[0], address, parameters: parameters as never }; });

  it("accepts and returns every parameter property", () => {
    const parameters = { tenantId: { description: "Tenant", enum: ["a", "b"], default: "a", examples: ["a"], location: "$message.payload#/tenant/id" } };
    expect(parsed(withParameters(parameters)).channels[0].parameters).toEqual(parameters);
  });
  it("accepts an empty parameter definition and both header and payload locations", () => {
    expect(pointersOf(withParameters({ tenantId: {} }))).toEqual([]);
    expect(pointersOf(withParameters({ tenantId: { location: "$message.header#/tenant" } }))).toEqual([]);
  });
  it.each(["payload#/tenant", "$message.body#/tenant", "$message.header#", "$message.header", "$message.header#tenant", "$message.header#/a~2b"])(
    "rejects the location %j", (location) => {
      expect(pointersOf(withParameters({ tenantId: { location } }))).toEqual(["/channels/0/parameters/tenantId/location"]);
    },
  );
  it("rejects a non-object parameter and unknown properties, at the parameter", () => {
    expect(pointersOf(withParameters({ tenantId: "string" }))).toEqual(["/channels/0/parameters/tenantId"]);
    expect(pointersOf(withParameters({ tenantId: { type: "string" } }))).toEqual(["/channels/0/parameters/tenantId/type"]);
  });
  it("validates the parameter enum, default and examples", () => {
    expect(pointersOf(withParameters({ tenantId: { enum: [1] } }))).toEqual(["/channels/0/parameters/tenantId/enum/0"]);
    expect(pointersOf(withParameters({ tenantId: { default: 1 } }))).toEqual(["/channels/0/parameters/tenantId/default"]);
    expect(pointersOf(withParameters({ tenantId: { examples: "a" } }))).toEqual(["/channels/0/parameters/tenantId/examples"]);
  });
  it("still demands a definition for every address expression, once, even when another parameter is malformed", () => {
    expect(pointersOf(withParameters({ other: { description: "x" } }))).toEqual(["/channels/0/parameters"]);
    expect(pointersOf(withParameters({ tenantId: { type: "string" } }))).toEqual(["/channels/0/parameters/tenantId/type"]); // defined, so no "needs a definition"
  });
  it("keeps the authored order of the parameters", () => {
    const channel = parsed(withParameters({ b: {}, a: {} }, "x.{b}.{a}")).channels[0];
    expect(Object.keys(channel.parameters ?? {})).toEqual(["b", "a"]);
  });
  it("validates tags, externalDocs and bindings", () => {
    expect(pointersOf(mutate((d) => { loose(d.channels[0]).tags = [{}]; }))).toEqual(["/channels/0/tags/0/name"]);
    expect(pointersOf(mutate((d) => { loose(d.channels[0]).externalDocs = {}; }))).toEqual(["/channels/0/externalDocs/url"]);
    expect(pointersOf(mutate((d) => { loose(d.channels[0]).bindings = []; }))).toEqual(["/channels/0/bindings"]);
    const ok = mutate((d) => { d.channels[0] = { ...d.channels[0], tags: [{ name: "t" }], externalDocs: { url: "https://example.com" }, bindings: { kafka: { partitions: 3 } } }; });
    expect(parsed(ok).channels[0]).toMatchObject({ tags: [{ name: "t" }], externalDocs: { url: "https://example.com" }, bindings: { kafka: { partitions: 3 } } });
  });
});

describe("messages", () => {
  it("accepts and returns every new message property", () => {
    const message = {
      key: "OrderCreated", name: "OrderCreated", title: "Order created", summary: "s", description: "d", contentType: "avro/binary",
      correlationId: { location: "$message.header#/correlationId", description: "Correlates" },
      tags: [{ name: "created" }], externalDocs: { url: "https://example.com/created" }, deprecated: true,
      bindings: { kafka: { schemaIdLocation: "payload" } },
      examples: [{ name: "small", summary: "A small order", headers: { traceparent: "00-1" }, payload: { id: "o-1" } }],
      payload: { entityId: "ent-order", entityVersionId: "ev1" }, traitKeys: [],
    };
    expect(parsed(mutate((d) => { d.messages[0] = message; })).messages[0]).toEqual(message);
  });
  it("trims and drops a blank name", () => {
    expect(parsed(mutate((d) => { d.messages[0].name = "  order.created "; })).messages[0].name).toBe("order.created");
    expect(parsed(mutate((d) => { d.messages[0].name = "  "; })).messages[0]).not.toHaveProperty("name");
    expect(pointersOf(mutate((d) => { loose(d.messages[0]).name = 3; }))).toEqual(["/messages/0/name"]);
  });

  describe("deprecated", () => {
    it("accepts true and false as authored", () => {
      expect(parsed(mutate((d) => { d.messages[0].deprecated = true; })).messages[0].deprecated).toBe(true);
      expect(parsed(mutate((d) => { d.messages[0].deprecated = false; })).messages[0].deprecated).toBe(false);
    });
    it.each(["yes", 1, "true", {}])("rejects %j", (value) => {
      expect(pointersOf(mutate((d) => { loose(d.messages[0]).deprecated = value; }))).toEqual(["/messages/0/deprecated"]);
    });
  });

  describe("correlationId", () => {
    it("requires a location", () => {
      expect(pointersOf(mutate((d) => { loose(d.messages[0]).correlationId = { description: "d" }; }))).toEqual(["/messages/0/correlationId/location"]);
      expect(pointersOf(mutate((d) => { loose(d.messages[0]).correlationId = { location: " " }; }))).toEqual(["/messages/0/correlationId/location"]);
    });
    it("takes a header or payload runtime expression and rejects anything else", () => {
      expect(pointersOf(mutate((d) => { d.messages[0].correlationId = { location: "$message.payload#/order/id" }; }))).toEqual([]);
      expect(pointersOf(mutate((d) => { d.messages[0].correlationId = { location: "$message.header#/x-correlation-id" }; }))).toEqual([]);
      expect(pointersOf(mutate((d) => { d.messages[0].correlationId = { location: "correlationId" }; }))).toEqual(["/messages/0/correlationId/location"]);
    });
    it("rejects a non-object, unknown properties and a non-string description", () => {
      expect(pointersOf(mutate((d) => { loose(d.messages[0]).correlationId = "id"; }))).toEqual(["/messages/0/correlationId"]);
      expect(pointersOf(mutate((d) => { loose(d.messages[0]).correlationId = { location: "$message.header#/a", extra: 1 }; }))).toEqual(["/messages/0/correlationId/extra"]);
      expect(pointersOf(mutate((d) => { loose(d.messages[0]).correlationId = { location: "$message.header#/a", description: 1 }; }))).toEqual(["/messages/0/correlationId/description"]);
    });
  });

  it("validates tags, externalDocs and bindings", () => {
    expect(pointersOf(mutate((d) => { loose(d.messages[0]).tags = [{ name: "" }]; }))).toEqual(["/messages/0/tags/0/name"]);
    expect(pointersOf(mutate((d) => { loose(d.messages[0]).externalDocs = { url: "x" }; }))).toEqual(["/messages/0/externalDocs/url"]);
    expect(pointersOf(mutate((d) => { loose(d.messages[0]).bindings = 1; }))).toEqual(["/messages/0/bindings"]);
  });

  describe("examples", () => {
    it("accepts headers only, payload only, and a null payload", () => {
      expect(pointersOf(mutate((d) => { d.messages[0].examples = [{ headers: { a: "1" } }, { payload: "text" }, { payload: null }, { payload: [1, 2] }, { payload: 0 }]; }))).toEqual([]);
    });
    it("requires headers or payload", () => {
      const p = problemsOf(mutate((d) => { d.messages[0].examples = [{ name: "ok", payload: {} }, { name: "empty" }]; }));
      expect(p.map((x) => x.pointer)).toEqual(["/messages/0/examples/1"]);
      expect(p[0].message).toMatch(/headers|payload/);
    });
    it("rejects non-object headers, non-string name and summary, unknown properties", () => {
      expect(pointersOf(mutate((d) => { loose(d.messages[0]).examples = [{ headers: "h", payload: 1 }]; }))).toEqual(["/messages/0/examples/0/headers"]);
      expect(pointersOf(mutate((d) => { loose(d.messages[0]).examples = [{ name: 1, payload: 1 }]; }))).toEqual(["/messages/0/examples/0/name"]);
      expect(pointersOf(mutate((d) => { loose(d.messages[0]).examples = [{ summary: [], payload: 1 }]; }))).toEqual(["/messages/0/examples/0/summary"]);
      expect(pointersOf(mutate((d) => { loose(d.messages[0]).examples = [{ payload: 1, description: "d" }]; }))).toEqual(["/messages/0/examples/0/description"]);
    });
    it("rejects a non-array and non-object entries", () => {
      expect(pointersOf(mutate((d) => { loose(d.messages[0]).examples = { payload: 1 }; }))).toEqual(["/messages/0/examples"]);
      expect(pointersOf(mutate((d) => { loose(d.messages[0]).examples = ["x"]; }))).toEqual(["/messages/0/examples/0"]);
    });
    it("keeps the authored order of examples", () => {
      const names = parsed(mutate((d) => { d.messages[0].examples = [{ name: "b", payload: 1 }, { name: "a", payload: 2 }]; })).messages[0].examples?.map((e) => e.name);
      expect(names).toEqual(["b", "a"]);
    });
  });
});

describe("operations", () => {
  it("accepts and returns every new operation property", () => {
    const operation = {
      key: "publishOrderCreated", action: "send" as const, channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [],
      title: "Publish order created", summary: "s", description: "d", security: ["basic"],
      tags: [{ name: "orders", externalDocs: { url: "https://example.com/orders" } }], externalDocs: { url: "https://example.com/op", description: "Op" },
      bindings: { kafka: { clientId: "checkout" } },
      reply: { address: { location: "$message.header#/replyTo", description: "Reply topic" }, channelKey: "orders", messageKeys: ["OrderCreated"] },
    };
    const d = mutate((x) => { x.operations[0] = operation; x.components = { securitySchemes: { basic: { type: "userPassword" } } }; });
    expect(parsed(d).operations[0]).toEqual(operation);
  });
  it("rejects a non-string title", () => {
    expect(pointersOf(mutate((d) => { loose(d.operations[0]).title = 2; }))).toEqual(["/operations/0/title"]);
  });
  it("validates tags, externalDocs and bindings", () => {
    expect(pointersOf(mutate((d) => { loose(d.operations[0]).tags = [{}]; }))).toEqual(["/operations/0/tags/0/name"]);
    expect(pointersOf(mutate((d) => { loose(d.operations[0]).externalDocs = { url: "nope" }; }))).toEqual(["/operations/0/externalDocs/url"]);
    expect(pointersOf(mutate((d) => { loose(d.operations[0]).bindings = "k"; }))).toEqual(["/operations/0/bindings"]);
  });

  describe("security", () => {
    it("reports a key that is not a security scheme", () => {
      expect(pointersOf(mutate((d) => { withSchemes({ basic: { type: "userPassword" } })(d); d.operations[0].security = ["basic", "ghost"]; }))).toEqual(["/operations/0/security/1"]);
      expect(pointersOf(mutate((d) => { d.operations[0].security = ["ghost"]; }))).toEqual(["/operations/0/security/0"]);
    });
    it("rejects a non-array and non-string entries", () => {
      expect(pointersOf(mutate((d) => { loose(d.operations[0]).security = "basic"; }))).toEqual(["/operations/0/security"]);
      expect(pointersOf(mutate((d) => { loose(d.operations[0]).security = [{ $ref: "#/x" }]; }))).toEqual(["/operations/0/security/0"]);
    });
  });

  describe("reply.address", () => {
    const withReply = (reply: unknown) => mutate((d) => { d.operations[0] = { ...d.operations[0], reply: reply as never }; });
    it("accepts a reply that carries only an address", () => {
      expect(parsed(withReply({ address: { location: "$message.payload#/replyTo" } })).operations[0].reply).toEqual({ address: { location: "$message.payload#/replyTo" } });
    });
    it("requires a location", () => {
      expect(pointersOf(withReply({ address: {} }))).toEqual(["/operations/0/reply/address/location"]);
      expect(pointersOf(withReply({ address: { description: "d" } }))).toEqual(["/operations/0/reply/address/location"]);
    });
    it.each(["replyTo", "$message.header#", "$message.header#replyTo", "$message.queue#/replyTo", "$message.payload#/a~9"])("rejects the location %j", (location) => {
      expect(pointersOf(withReply({ address: { location } }))).toEqual(["/operations/0/reply/address/location"]);
    });
    it("rejects a non-object address, unknown properties and a non-string description", () => {
      expect(pointersOf(withReply({ address: "$message.header#/x" }))).toEqual(["/operations/0/reply/address"]);
      expect(pointersOf(withReply({ address: { location: "$message.header#/x", queue: "q" } }))).toEqual(["/operations/0/reply/address/queue"]);
      expect(pointersOf(withReply({ address: { location: "$message.header#/x", description: 1 } }))).toEqual(["/operations/0/reply/address/description"]);
    });
    it("keeps the existing reply checks working next to the address", () => {
      expect(pointersOf(withReply({ address: { location: "$message.header#/x" }, messageKeys: ["OrderCreated"] }))).toEqual(["/operations/0/reply/channelKey"]);
    });
  });
});

describe("local traits", () => {
  const trait = (kind: "MESSAGE" | "OPERATION", spec: unknown) => mutate((d) => { d.traits = [{ key: "t1", kind, spec: spec as never }]; d.messages[0].traitKeys = []; });

  it("accepts every property of a message trait", () => {
    const spec = {
      name: "envelope", title: "Envelope", summary: "s", description: "d", contentType: "application/json",
      correlationId: { location: "$message.header#/id", description: "Id" }, tags: [{ name: "envelope" }],
      externalDocs: { url: "https://example.com/envelope" }, deprecated: false,
      examples: [{ name: "e", headers: { a: "1" } }], bindings: { kafka: { schemaIdLocation: "header" } },
      headers: { type: "object", properties: { id: { type: "string" } } },
    };
    expect(parsed(trait("MESSAGE", spec)).traits[0]).toEqual({ key: "t1", kind: "MESSAGE", spec });
  });
  it("accepts every property of an operation trait", () => {
    const spec = {
      title: "Audited", summary: "s", description: "d", security: ["basic"], tags: [{ name: "audited" }],
      externalDocs: { url: "https://example.com/audit" }, bindings: { kafka: { groupId: "audit" } },
    };
    const d = trait("OPERATION", spec);
    d.components = { securitySchemes: { basic: { type: "userPassword" } } };
    expect(parsed(d).traits[0]).toEqual({ key: "t1", kind: "OPERATION", spec });
  });
  it("allows x- extensions and an empty spec, and keeps the authored key order of the spec", () => {
    expect(parsed(trait("MESSAGE", { "x-owner": { team: "platform" }, summary: "s" })).traits[0]).toEqual({ key: "t1", kind: "MESSAGE", spec: { "x-owner": { team: "platform" }, summary: "s" } });
    expect(parsed(trait("OPERATION", {})).traits[0]).toEqual({ key: "t1", kind: "OPERATION", spec: {} });
    const spec = (parsed(trait("MESSAGE", { tags: [{ name: "a" }], title: "t", summary: "s" })).traits[0] as { spec: object }).spec;
    expect(Object.keys(spec)).toEqual(["tags", "title", "summary"]);
  });

  describe("unknown keys are reported per kind at /traits/<i>/spec/<key>", () => {
    it("rejects a key AsyncAPI does not define for the kind", () => {
      expect(pointersOf(trait("MESSAGE", { color: "red" }))).toEqual(["/traits/0/spec/color"]);
      expect(pointersOf(trait("OPERATION", { color: "red" }))).toEqual(["/traits/0/spec/color"]);
    });
    it("rejects an operation-trait key on a message trait and the reverse", () => {
      expect(pointersOf(trait("MESSAGE", { security: ["basic"] }))).toEqual(["/traits/0/spec/security"]);
      expect(pointersOf(trait("OPERATION", { contentType: "application/json" }))).toEqual(["/traits/0/spec/contentType"]);
      expect(pointersOf(trait("OPERATION", { correlationId: { location: "$message.header#/a" } }))).toEqual(["/traits/0/spec/correlationId"]);
      expect(pointersOf(trait("OPERATION", { deprecated: true }))).toEqual(["/traits/0/spec/deprecated"]);
      expect(pointersOf(trait("OPERATION", { headers: {} }))).toEqual(["/traits/0/spec/headers"]);
    });
    it("reports each unknown key once, at the trait's position among several", () => {
      const d = mutate((x) => { x.traits.push({ key: "t3", kind: "MESSAGE", spec: { a: 1, b: 2, summary: "ok" } }); });
      expect(pointersOf(d)).toEqual([`/traits/${d.traits.length - 1}/spec/a`, `/traits/${d.traits.length - 1}/spec/b`]);
    });
    it("escapes the key in the pointer", () => {
      expect(pointersOf(trait("MESSAGE", { "a/b": 1 }))).toEqual(["/traits/0/spec/a~1b"]);
    });
    it("skips the per-kind spec check when the kind itself is invalid, and never checks library traits", () => {
      expect(pointersOf(mutate(() => undefined))).toEqual([]);
      expect(pointersOf(mutate((d) => { d.traits[0] = { key: "CloudEvents", kind: "WHATEVER" as never, spec: { color: "red" } }; }))).toEqual(["/traits/0/kind"]);
    });
  });

  describe("values are validated like the message / operation fields they mirror", () => {
    it("message trait values", () => {
      expect(pointersOf(trait("MESSAGE", { deprecated: "yes" }))).toEqual(["/traits/0/spec/deprecated"]);
      expect(pointersOf(trait("MESSAGE", { title: 4 }))).toEqual(["/traits/0/spec/title"]);
      expect(pointersOf(trait("MESSAGE", { correlationId: { description: "no location" } }))).toEqual(["/traits/0/spec/correlationId/location"]);
      expect(pointersOf(trait("MESSAGE", { tags: [{ name: "" }] }))).toEqual(["/traits/0/spec/tags/0/name"]);
      expect(pointersOf(trait("MESSAGE", { externalDocs: { url: "x" } }))).toEqual(["/traits/0/spec/externalDocs/url"]);
      expect(pointersOf(trait("MESSAGE", { examples: [{ name: "n" }] }))).toEqual(["/traits/0/spec/examples/0"]);
      expect(pointersOf(trait("MESSAGE", { bindings: [] }))).toEqual(["/traits/0/spec/bindings"]);
      expect(pointersOf(trait("MESSAGE", { headers: "h" }))).toEqual(["/traits/0/spec/headers"]);
    });
    it("operation trait values", () => {
      expect(pointersOf(trait("OPERATION", { summary: 4 }))).toEqual(["/traits/0/spec/summary"]);
      expect(pointersOf(trait("OPERATION", { tags: "x" }))).toEqual(["/traits/0/spec/tags"]);
      expect(pointersOf(trait("OPERATION", { bindings: "k" }))).toEqual(["/traits/0/spec/bindings"]);
    });
    it("operation trait security keys must be security schemes", () => {
      expect(pointersOf(trait("OPERATION", { security: ["ghost"] }))).toEqual(["/traits/0/spec/security/0"]);
      const d = trait("OPERATION", { security: ["basic", "ghost"] });
      d.components = { securitySchemes: { basic: { type: "userPassword" } } };
      expect(pointersOf(d)).toEqual(["/traits/0/spec/security/1"]);
      expect(pointersOf(trait("OPERATION", { security: "basic" }))).toEqual(["/traits/0/spec/security"]);
    });
  });

  it("still requires exactly one of spec or libraryTraitId", () => {
    expect(pointersOf(mutate((d) => { d.traits[0] = { key: "CloudEvents", kind: "MESSAGE" } as never; }))).toEqual(["/traits/0"]);
  });
});

describe("components.securitySchemes", () => {
  const scheme = (value: unknown) => mutate(withSchemes({ s: value } as never));

  it.each([
    [{ type: "userPassword", description: "Username and password" }],
    [{ type: "apiKey", in: "user", description: "Key as user" }],
    [{ type: "apiKey", in: "password" }],
    [{ type: "X509" }],
    [{ type: "symmetricEncryption", description: "d" }],
    [{ type: "asymmetricEncryption" }],
    [{ type: "httpApiKey", name: "X-Api-Key", in: "header" }],
    [{ type: "httpApiKey", name: "key", in: "query" }],
    [{ type: "httpApiKey", name: "sid", in: "cookie" }],
    [{ type: "http", scheme: "basic" }],
    [{ type: "http", scheme: "bearer", bearerFormat: "JWT" }],
    [{ type: "oauth2", flows: { implicit: { authorizationUrl: "https://auth.example.com/authorize", availableScopes: { read: "Read" } } } }],
    [{ type: "oauth2", flows: { password: { tokenUrl: "https://auth.example.com/token", refreshUrl: "https://auth.example.com/refresh", availableScopes: {} } }, scopes: ["read"] }],
    [{ type: "oauth2", flows: { clientCredentials: { tokenUrl: "https://auth.example.com/token", availableScopes: { read: "Read" } } } }],
    [{ type: "oauth2", flows: { authorizationCode: { authorizationUrl: "https://auth.example.com/authorize", tokenUrl: "https://auth.example.com/token", availableScopes: { read: "Read" } } } }],
    [{ type: "openIdConnect", openIdConnectUrl: "https://auth.example.com/.well-known/openid-configuration", scopes: ["openid"] }],
    [{ type: "plain" }],
    [{ type: "scramSha256" }],
    [{ type: "scramSha512", description: "d" }],
    [{ type: "gssapi" }],
    [{ type: "userPassword", "x-vendor": { a: 1 } }],
  ])("accepts %j and returns it as authored", (value) => {
    const d = scheme(value);
    expect(pointersOf(d)).toEqual([]);
    expect(parsed(d).components?.securitySchemes?.s).toEqual(value);
  });

  it("requires a type from the AsyncAPI list", () => {
    expect(pointersOf(scheme({ description: "d" }))).toEqual(["/components/securitySchemes/s/type"]);
    expect(pointersOf(scheme({ type: "saml" }))).toEqual(["/components/securitySchemes/s/type"]);
    expect(pointersOf(scheme({ type: 3 }))).toEqual(["/components/securitySchemes/s/type"]);
  });
  it("rejects a non-object scheme and a non-object map", () => {
    expect(pointersOf(scheme("basic"))).toEqual(["/components/securitySchemes/s"]);
    expect(pointersOf(mutate((d) => { (d as { components?: unknown }).components = { securitySchemes: [] }; }))).toEqual(["/components/securitySchemes"]);
  });
  it("rejects a key that cannot be referenced and a reserved key", () => {
    expect(pointersOf(mutate(withSchemes({ "bad key": { type: "plain" } })))).toEqual(["/components/securitySchemes/bad key"]);
    expect(pointersOf(mutate(withSchemes({ constructor: { type: "plain" } } as never)))).toEqual(["/components/securitySchemes/constructor"]);
  });
  it("rejects a non-string description and unknown properties", () => {
    expect(pointersOf(scheme({ type: "plain", description: 1 }))).toEqual(["/components/securitySchemes/s/description"]);
    expect(pointersOf(scheme({ type: "plain", scheme: "basic" }))).toEqual(["/components/securitySchemes/s/scheme"]);
    expect(pointersOf(scheme({ type: "X509", in: "header" }))).toEqual(["/components/securitySchemes/s/in"]);
  });

  describe("type-specific required fields", () => {
    it("apiKey needs `in` (user or password)", () => {
      expect(pointersOf(scheme({ type: "apiKey" }))).toEqual(["/components/securitySchemes/s/in"]);
      expect(pointersOf(scheme({ type: "apiKey", in: "header" }))).toEqual(["/components/securitySchemes/s/in"]);
    });
    it("httpApiKey needs `name` and `in` (header, query or cookie)", () => {
      expect(pointersOf(scheme({ type: "httpApiKey" }))).toEqual(["/components/securitySchemes/s/name", "/components/securitySchemes/s/in"]);
      expect(pointersOf(scheme({ type: "httpApiKey", name: "k", in: "user" }))).toEqual(["/components/securitySchemes/s/in"]);
    });
    it("http needs `scheme`; bearerFormat only goes with bearer", () => {
      expect(pointersOf(scheme({ type: "http" }))).toEqual(["/components/securitySchemes/s/scheme"]);
      expect(pointersOf(scheme({ type: "http", scheme: "basic", bearerFormat: "JWT" }))).toEqual(["/components/securitySchemes/s/bearerFormat"]);
    });
    it("oauth2 needs `flows` with at least one flow", () => {
      expect(pointersOf(scheme({ type: "oauth2" }))).toEqual(["/components/securitySchemes/s/flows"]);
      expect(pointersOf(scheme({ type: "oauth2", flows: {} }))).toEqual(["/components/securitySchemes/s/flows"]);
      expect(pointersOf(scheme({ type: "oauth2", flows: "implicit" }))).toEqual(["/components/securitySchemes/s/flows"]);
      expect(pointersOf(scheme({ type: "oauth2", flows: { device: {} } }))).toEqual(["/components/securitySchemes/s/flows/device", "/components/securitySchemes/s/flows"]);
    });
    it("each oauth2 flow needs its own fields and rejects the ones that do not apply", () => {
      const base = "/components/securitySchemes/s/flows";
      expect(pointersOf(scheme({ type: "oauth2", flows: { implicit: {} } }))).toEqual([`${base}/implicit/authorizationUrl`, `${base}/implicit/availableScopes`]);
      expect(pointersOf(scheme({ type: "oauth2", flows: { password: {} } }))).toEqual([`${base}/password/tokenUrl`, `${base}/password/availableScopes`]);
      expect(pointersOf(scheme({ type: "oauth2", flows: { clientCredentials: {} } }))).toEqual([`${base}/clientCredentials/tokenUrl`, `${base}/clientCredentials/availableScopes`]);
      expect(pointersOf(scheme({ type: "oauth2", flows: { authorizationCode: {} } })))
        .toEqual([`${base}/authorizationCode/authorizationUrl`, `${base}/authorizationCode/tokenUrl`, `${base}/authorizationCode/availableScopes`]);
      expect(pointersOf(scheme({ type: "oauth2", flows: { implicit: { authorizationUrl: "https://a.example.com", tokenUrl: "https://t.example.com", availableScopes: {} } } })))
        .toEqual([`${base}/implicit/tokenUrl`]);
      expect(pointersOf(scheme({ type: "oauth2", flows: { clientCredentials: { authorizationUrl: "https://a.example.com", tokenUrl: "https://t.example.com", availableScopes: {} } } })))
        .toEqual([`${base}/clientCredentials/authorizationUrl`]);
    });
    it("oauth2 flow urls are http(s) urls and scope descriptions are strings", () => {
      const base = "/components/securitySchemes/s/flows/authorizationCode";
      const flow = { authorizationUrl: "https://a.example.com", tokenUrl: "https://t.example.com", availableScopes: { read: "Read" } };
      expect(pointersOf(scheme({ type: "oauth2", flows: { authorizationCode: { ...flow, authorizationUrl: "authorize" } } }))).toEqual([`${base}/authorizationUrl`]);
      expect(pointersOf(scheme({ type: "oauth2", flows: { authorizationCode: { ...flow, tokenUrl: "ftp://t" } } }))).toEqual([`${base}/tokenUrl`]);
      expect(pointersOf(scheme({ type: "oauth2", flows: { authorizationCode: { ...flow, refreshUrl: "r" } } }))).toEqual([`${base}/refreshUrl`]);
      expect(pointersOf(scheme({ type: "oauth2", flows: { authorizationCode: { ...flow, availableScopes: { read: 1 } } } }))).toEqual([`${base}/availableScopes/read`]);
      expect(pointersOf(scheme({ type: "oauth2", flows: { authorizationCode: { ...flow, availableScopes: ["read"] } } }))).toEqual([`${base}/availableScopes`]);
      expect(pointersOf(scheme({ type: "oauth2", flows: { authorizationCode: { ...flow, extra: 1 } } }))).toEqual([`${base}/extra`]);
    });
    it("oauth2 and openIdConnect scopes are string lists", () => {
      const flows = { implicit: { authorizationUrl: "https://a.example.com", availableScopes: {} } };
      expect(pointersOf(scheme({ type: "oauth2", flows, scopes: "read" }))).toEqual(["/components/securitySchemes/s/scopes"]);
      expect(pointersOf(scheme({ type: "oauth2", flows, scopes: ["read", 1] }))).toEqual(["/components/securitySchemes/s/scopes/1"]);
      expect(pointersOf(scheme({ type: "openIdConnect", openIdConnectUrl: "https://a.example.com", scopes: [2] }))).toEqual(["/components/securitySchemes/s/scopes/0"]);
    });
    it("openIdConnect needs an http(s) openIdConnectUrl", () => {
      expect(pointersOf(scheme({ type: "openIdConnect" }))).toEqual(["/components/securitySchemes/s/openIdConnectUrl"]);
      expect(pointersOf(scheme({ type: "openIdConnect", openIdConnectUrl: "discovery" }))).toEqual(["/components/securitySchemes/s/openIdConnectUrl"]);
    });
  });

  it("keeps the authored order of the schemes and of each scheme's keys", () => {
    const d = mutate(withSchemes({ zeta: { type: "plain", description: "z" }, alpha: { description: "a", type: "http", scheme: "basic" } } as never));
    const schemes = parsed(d).components?.securitySchemes ?? {};
    expect(Object.keys(schemes)).toEqual(["zeta", "alpha"]);
    expect(Object.keys(schemes.alpha)).toEqual(["description", "type", "scheme"]);
  });
});

describe("authored order and blank handling", () => {
  it("keeps the authored key order of nested objects the assembler emits verbatim", () => {
    const d = mutate((x) => {
      x.info.contact = { email: "a@b.co", name: "N", url: "https://example.com" };
      x.info.tags = [{ externalDocs: { description: "d", url: "https://example.com" }, name: "t" }];
    });
    const info = parsed(d).info;
    expect(Object.keys(info.contact ?? {})).toEqual(["email", "name", "url"]);
    expect(Object.keys(info.tags?.[0] ?? {})).toEqual(["externalDocs", "name"]);
    expect(Object.keys(info.tags?.[0].externalDocs ?? {})).toEqual(["description", "url"]);
  });
  it("trims strings and drops blank optional values at every new level", () => {
    const d = mutate((x) => {
      x.servers[0] = { ...x.servers[0], title: " T ", summary: "  " };
      x.operations[0] = { ...x.operations[0], title: "", reply: { address: { location: " $message.header#/r ", description: " " } } };
    });
    const out = parsed(d);
    expect(out.servers[0].title).toBe("T");
    expect(out.servers[0]).not.toHaveProperty("summary");
    expect(out.operations[0]).not.toHaveProperty("title");
    expect(out.operations[0].reply).toEqual({ address: { location: "$message.header#/r" } });
  });
  it("treats null as absent for every new optional field", () => {
    const d = mutate((x) => {
      const s = loose(x.servers[0]);
      Object.assign(s, { title: null, summary: null, variables: null, security: null, tags: null, externalDocs: null, bindings: null });
      const m = loose(x.messages[0]);
      Object.assign(m, { name: null, deprecated: null, correlationId: null, examples: null });
      const o = loose(x.operations[0]);
      Object.assign(o, { title: null, security: null, tags: null, externalDocs: null });
      Object.assign(x.info, { termsOfService: null });
    });
    expect(parseEventDocument(d).success).toBe(true);
  });
  it("reports problems from every part of the document in one pass", () => {
    const d = mutate((x) => {
      x.info.termsOfService = "terms";
      x.servers[0] = { ...x.servers[0], variables: { env: {} }, security: ["ghost"] };
      x.messages[0].deprecated = "yes" as never;
      x.operations[0].title = 9 as never;
    });
    expect(new Set(pointersOf(d))).toEqual(new Set([
      "/info/termsOfService", "/servers/0/variables/env", "/servers/0/security/0", "/messages/0/deprecated", "/operations/0/title",
    ]));
  });
});
