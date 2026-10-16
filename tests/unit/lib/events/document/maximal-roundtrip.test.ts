// tests/unit/lib/events/document/maximal-roundtrip.test.ts
// WP-1a: a document that uses every AsyncAPI 3.0 property the model carries survives parse → resolve → assemble and the
// emitted AsyncAPI validates (the repo's structural validator AND the real @asyncapi/parser). The property coverage is
// checked against @asyncapi/specs itself, so "every property" is a tested claim.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { toJson, toYaml } from "@/lib/event-specs/serialize";
import type { Diagnostic, JsonObject } from "@/lib/event-specs/types";
import { validateAsyncApi3Structure } from "@/lib/event-specs/validator";
import { AsyncApiParserValidator } from "@/lib/event-specs/validation/asyncapi-parser-validator";
import { parseEventDocument } from "@/lib/events/document/parse";
import {
  MESSAGE_TRAIT_SPEC_KEYS, OPERATION_TRAIT_SPEC_KEYS, SECURITY_SCHEME_TYPES, type EventDocument,
} from "@/lib/events/document/types";
import { runPipeline } from "./fixtures/compat-pipeline";
import { maximalArtifacts, maximalDocument } from "./fixtures/maximal-document";

const run = (doc: EventDocument = maximalDocument()) => runPipeline(doc, { ...maximalArtifacts(), emitChannelServers: true });

const specs = JSON.parse(readFileSync(path.join(process.cwd(), "node_modules/@asyncapi/specs/schemas/3.0.0.json"), "utf8")) as {
  definitions: Record<string, JsonObject>;
};
const definition = (name: string): JsonObject => {
  const found = specs.definitions[`http://asyncapi.com/definitions/3.0.0/${name}.json`];
  if (!found) throw new Error(`@asyncapi/specs has no definition "${name}"`);
  return found;
};
/** Property names of a definition, following `allOf` (info's properties sit in its first `allOf` member). `x-…` extensions excluded. */
function propertiesOf(def: JsonObject): string[] {
  const own = typeof def.properties === "object" && def.properties !== null ? Object.keys(def.properties) : [];
  const nested = Array.isArray(def.allOf) ? def.allOf.flatMap((member) => (typeof member === "object" && member !== null ? propertiesOf(member as JsonObject) : [])) : [];
  return [...new Set([...own, ...nested])].filter((key) => !key.startsWith("x-"));
}

type Emitted = JsonObject & {
  info: JsonObject & { contact: JsonObject; license: JsonObject; tags: JsonObject[]; externalDocs: JsonObject };
  servers: Record<string, JsonObject & { variables: Record<string, JsonObject>; tags: JsonObject[] }>;
  channels: Record<string, JsonObject & { parameters: Record<string, JsonObject> }>;
  operations: Record<string, JsonObject & { reply: JsonObject & { address: JsonObject } }>;
  components: JsonObject & {
    messages: Record<string, JsonObject & { examples: JsonObject[] }>;
    messageTraits: Record<string, JsonObject>;
    operationTraits: Record<string, JsonObject>;
    securitySchemes: Record<string, JsonObject & { flows?: Record<string, JsonObject> }>;
  };
};

describe("maximal document", () => {
  it("parses to exactly what was authored", () => {
    const parsed = parseEventDocument(maximalDocument());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(maximalDocument());
  });

  it("assembles without a single diagnostic", () => {
    expect(run().diagnostics).toEqual([]);
  });

  it("passes the repo's structural validator", () => {
    expect(validateAsyncApi3Structure(run().document).filter((d) => d.severity === "error")).toEqual([]);
  });

  it("passes the real @asyncapi/parser with no errors", async () => {
    const result = await new AsyncApiParserValidator().validate(run().document);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const errors: Diagnostic[] = result.data.filter((d) => d.severity === "error");
    expect(errors).toEqual([]);
  }, 60_000);

  it("emits YAML and JSON that read back to the same document", () => {
    const { document } = run();
    expect(parseYaml(toYaml(document), { version: "1.1" })).toEqual(document);
    expect(JSON.parse(toJson(document))).toEqual(document);
  });

  it("emits the same bytes on every run", () => {
    expect(toJson(run().document)).toBe(toJson(run(structuredClone(maximalDocument())).document));
  });

  it("emits in AsyncAPI-canonical positions", () => {
    const document = run().document as Emitted;
    expect(Object.keys(document.info)).toEqual(["title", "version", "description", "termsOfService", "contact", "license", "tags", "externalDocs"]);
    expect(Object.keys(document.servers["kafka-prod"])).toEqual([
      "host", "protocol", "protocolVersion", "pathname", "title", "summary", "description", "variables", "security", "tags", "externalDocs", "bindings",
    ]);
    expect(Object.keys(document.channels.orders)).toEqual(["address", "messages", "title", "summary", "description", "servers", "parameters", "tags", "externalDocs", "bindings"]);
    expect(Object.keys(document.operations.createOrder)).toEqual([
      "action", "channel", "title", "summary", "description", "security", "tags", "externalDocs", "bindings", "traits", "messages", "reply",
    ]);
    expect(Object.keys(document.operations.createOrder.reply)).toEqual(["address", "channel", "messages"]);
  });

  it("emits server and operation security as $refs to components.securitySchemes", () => {
    const document = run().document as Emitted;
    const ref = (key: string) => ({ $ref: `#/components/securitySchemes/${key}` });
    expect(document.servers["kafka-prod"].security).toEqual([ref("basic"), ref("oauth"), ref("apiKeyUser")]);
    expect(document.operations.createOrder.security).toEqual([ref("apiKeyUser"), ref("gss")]);
    expect(document.components.operationTraits.Audited.security).toEqual([ref("basic")]);
    expect(Object.keys(document.components.securitySchemes)).toEqual(Object.keys(maximalDocument().components?.securitySchemes ?? {}).sort());
  });

  it("emits the channel servers as $refs, never the server's origin", () => {
    const document = run().document as Emitted;
    expect(document.channels.orders.servers).toEqual([{ $ref: "#/servers/kafka-prod" }, { $ref: "#/servers/kafka-stage" }]);
    expect(JSON.stringify(document)).not.toContain("origin");
  });

  describe("covers every property @asyncapi/specs defines", () => {
    const emitted = () => run().document as Emitted;
    const scheme = (key: string) => emitted().components.securitySchemes[key];
    const message = () => emitted().components.messages.OrderCreated;
    const cases: Array<[definition: string, pick: (d: Emitted) => JsonObject]> = [
      ["info", (d) => d.info],
      ["contact", (d) => d.info.contact],
      ["license", (d) => d.info.license],
      ["tag", (d) => d.info.tags[0]],
      ["externalDocs", (d) => d.info.externalDocs],
      ["server", (d) => d.servers["kafka-prod"]],
      ["serverVariable", (d) => d.servers["kafka-prod"].variables.env],
      ["channel", (d) => d.channels.orders],
      ["parameter", (d) => d.channels.orders.parameters.region],
      ["operation", (d) => d.operations.createOrder],
      ["operationReply", (d) => d.operations.createOrder.reply],
      ["operationReplyAddress", (d) => d.operations.createOrder.reply.address],
      ["messageObject", (d) => d.components.messages.OrderCreated],
      ["correlationId", (d) => d.components.messages.OrderCreated.correlationId as JsonObject],
      ["messageExampleObject", (d) => d.components.messages.OrderCreated.examples[0]],
      ["messageTrait", (d) => d.components.messageTraits.Envelope],
      ["operationTrait", (d) => d.components.operationTraits.Audited],
      ["userPassword", (d) => d.components.securitySchemes.basic],
      ["apiKey", (d) => d.components.securitySchemes.apiKeyUser],
      ["X509", (d) => d.components.securitySchemes.cert],
      ["symmetricEncryption", (d) => d.components.securitySchemes.sym],
      ["asymmetricEncryption", (d) => d.components.securitySchemes.asym],
      ["APIKeyHTTPSecurityScheme", (d) => d.components.securitySchemes.headerKey],
      ["BearerHTTPSecurityScheme", (d) => d.components.securitySchemes.bearer],
      ["NonBearerHTTPSecurityScheme", (d) => d.components.securitySchemes.httpBasic],
      ["oauth2Flows", (d) => d.components.securitySchemes.oauth],
      ["openIdConnect", (d) => d.components.securitySchemes.oidc],
      ["SaslPlainSecurityScheme", (d) => d.components.securitySchemes.plain],
      ["SaslScramSecurityScheme", (d) => d.components.securitySchemes.scram256],
      ["SaslGssapiSecurityScheme", (d) => d.components.securitySchemes.gss],
    ];
    it.each(cases)("%s", (name, pick) => {
      const expected = propertiesOf(definition(name));
      expect(expected.length).toBeGreaterThan(0);
      const actual = Object.keys(pick(emitted()));
      expect(expected.filter((property) => !actual.includes(property))).toEqual([]);
    });

    it("oauth2 flows: every flow and every flow property", () => {
      const flows = scheme("oauth").flows as Record<string, JsonObject>;
      const flowsProperty = (definition("oauth2Flows").properties as { flows: { properties: JsonObject } }).flows.properties;
      expect(Object.keys(flows).sort()).toEqual(Object.keys(flowsProperty).sort());
      const flowProperties = new Set(Object.values(flows).flatMap((flow) => Object.keys(flow)));
      expect([...flowProperties].sort()).toEqual(propertiesOf(definition("oauth2Flow")).sort());
    });

    it("message example headers and payload both appear across the examples", () => {
      const examples = message().examples as JsonObject[];
      expect(examples.some((e) => "headers" in e)).toBe(true);
      expect(examples.some((e) => "payload" in e)).toBe(true);
    });
  });

  describe("the model's key lists match @asyncapi/specs", () => {
    it("security scheme types are exactly the types the spec defines", () => {
      const typesOf = (def: JsonObject): string[] => {
        if (Array.isArray(def.oneOf)) return def.oneOf.flatMap((member) => typesOf(specs.definitions[(member as { $ref: string }).$ref]));
        return (def.properties as { type: { enum: string[] } }).type.enum;
      };
      expect([...new Set(typesOf(definition("SecurityScheme")))].sort()).toEqual([...SECURITY_SCHEME_TYPES].sort());
    });
    it("message trait spec keys are exactly the Message Trait Object's properties", () => {
      expect([...MESSAGE_TRAIT_SPEC_KEYS].sort()).toEqual(propertiesOf(definition("messageTrait")).sort());
    });
    it("operation trait spec keys are exactly the Operation Trait Object's properties", () => {
      expect([...OPERATION_TRAIT_SPEC_KEYS].sort()).toEqual(propertiesOf(definition("operationTrait")).sort());
    });
  });
});
