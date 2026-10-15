import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DiagnosticSeverity, Parser } from "@asyncapi/parser";
import { AsyncApi3Adapter } from "@/lib/event-specs/adapter";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import { GENERIC_VALIDATION_FAILURE, StructuralAsyncApi3Validator, validateAsyncApi3Structure } from "@/lib/event-specs/validator";
import {
  AsyncApiParserValidator,
  createAsyncApiParser,
  mapParserDiagnostic,
} from "@/lib/event-specs/validation/asyncapi-parser-validator";
import type { Diagnostic, JsonObject, SchemaArtifact } from "@/lib/event-specs/types";
import { channel, message, operation, spec } from "./fixtures/builders";
import { checkoutServiceSpec } from "./fixtures/worked-example";

/**
 * Story 18.5 / ruling R26 — the assembler's documents through the REAL
 * `@asyncapi/parser` (no mocks): the golden documents, the `$ref` rebasing
 * assumption (plan decision D8), remote-`$ref` blocking and adapter wiring.
 */

const GOLDEN_DIR = path.join(__dirname, "__golden__");
const golden = (name: string): JsonObject =>
  JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${name}.asyncapi.json`), "utf8")) as JsonObject;

const validator = new AsyncApiParserValidator();

async function validate(document: object): Promise<Diagnostic[]> {
  const res = await validator.validate(document);
  if (!res.success) throw new Error(`${res.error.code}: ${res.error.message}`);
  return res.data;
}

const errorsOf = (list: Diagnostic[]): Diagnostic[] => list.filter((d) => d.severity === "error");

/** The checkout-service golden with `operations.publishOrderCreated.channel` pointing at a channel that does not exist. */
function documentWithMissingChannel(): JsonObject {
  const doc = structuredClone(golden("checkout-service"));
  (doc.operations as { publishOrderCreated: JsonObject }).publishOrderCreated.channel = {
    $ref: "#/channels/missing",
  };
  return doc;
}

const jsonDraft07Channel = channel({
  id: "ch-json",
  name: "orders-json",
  profile: { format: "json-schema", dialect: "draft-07" },
});

/** A message whose JSON Schema payload uses `$ref` into the schema's own definitions. */
function jsonPayloadDocument(payload: SchemaArtifact): JsonObject {
  return assembleAsyncApi3(
    spec({
      channels: [jsonDraft07Channel],
      messages: [message({ id: "m", name: "M", payloads: [payload] })],
      operations: [operation({ key: "o", channelRef: jsonDraft07Channel.id, messageRefs: ["m"] })],
    }),
  ).document;
}

const DRAFT_07_WITH_DEFINITIONS: SchemaArtifact = {
  format: "json-schema",
  dialect: "draft-07",
  schema: { type: "object", properties: { a: { $ref: "#/definitions/A" } }, definitions: { A: { type: "string" } } },
};

const DRAFT_2020_12_WITH_DEFS: SchemaArtifact = {
  format: "json-schema",
  dialect: "2020-12",
  schema: { type: "object", properties: { a: { $ref: "#/$defs/A" } }, $defs: { A: { type: "string" } } },
};

type ParsedMessagePayload = {
  components: { messages: { M: { payload: { schema: { properties: { a: JsonObject } } } } } };
};

describe("AsyncApiParserValidator (real @asyncapi/parser)", { timeout: 60_000 }, () => {
  describe("golden documents", () => {
    it.each(["checkout-service", "fraud-scorer"])("%s validates with zero error diagnostics", async (name) => {
      const diagnostics = await validate(golden(name));
      expect(errorsOf(diagnostics)).toEqual([]);
      expect(diagnostics.filter((d) => d.code === "PAYLOAD_NOT_VALIDATED")).toEqual([]);
      for (const d of diagnostics) expect(d.pointer === "" || d.pointer.startsWith("/")).toBe(true);
    });

    it("exposes the validator name", () => {
      expect(validator.name).toBe("asyncapi-parser");
    });
  });

  describe("Kafka key (the Kafka binding types `key` as a JSON Schema Object; the key schema is validated by this validator)", () => {
    const avroChannel = channel({ id: "ch-avro", name: "orders", profile: { format: "avro" } });
    const keyedDocument = (key: SchemaArtifact, channelRef: ReturnType<typeof channel>) =>
      assembleAsyncApi3(
        spec({
          channels: [channelRef],
          messages: [message({ id: "m", name: "M", keys: [key] })],
          operations: [operation({ key: "o", channelRef: channelRef.id, messageRefs: ["m"] })],
        }),
      ).document;
    const keyOf = (document: JsonObject): JsonObject =>
      (document.components as { messages: { M: { bindings: { kafka: { key: JsonObject } } } } }).messages.M.bindings.kafka.key;
    /** The assembled Avro-key document with the key replaced (in the components copy, the only place a key is stored). */
    const withKey = (key: unknown): JsonObject => {
      const document = keyedDocument({ format: "avro", schema: { type: "record", name: "K", fields: [] } }, avroChannel);
      (document.components as { messages: { M: { bindings: { kafka: { key: unknown } } } } }).messages.M.bindings.kafka.key = key;
      return document;
    };
    const KEY_POINTER = "/components/messages/M/bindings/kafka/key";

    it("accepts a wrapped Avro RECORD key (the parser binding check passes AND the key schema is parsed as Avro)", async () => {
      const schema = { type: "record", name: "OrderKey", namespace: "acme.test", fields: [{ name: "id", type: "string" }] };
      const document = keyedDocument({ format: "avro", schema }, avroChannel);
      expect(keyOf(document)).toEqual({ schemaFormat: "application/vnd.apache.avro+json;version=1.9.0", schema });
      expect(errorsOf(await validate(document))).toEqual([]);
    });

    it("rejects an Avro key that is not valid Avro (record without name / fields) at the key pointer", async () => {
      const errors = errorsOf(
        await validate(withKey({ schemaFormat: "application/vnd.apache.avro+json;version=1.9.0", schema: { type: "record" } })),
      );
      expect(errors.map((d) => [d.code, d.pointer])).toContainEqual(["KAFKA_KEY_SCHEMA_INVALID", KEY_POINTER]);
      expect(errors.find((d) => d.code === "KAFKA_KEY_SCHEMA_INVALID")?.message).toMatch(/^Kafka key Avro schema is invalid: /);
    });

    it("rejects an Avro key whose schema is not a schema at all, and an unknown schemaFormat", async () => {
      const badAvro = errorsOf(await validate(withKey({ schemaFormat: "application/vnd.apache.avro+json;version=1.9.0", schema: 12345 })));
      expect(badAvro.map((d) => [d.code, d.pointer])).toContainEqual(["KAFKA_KEY_SCHEMA_INVALID", KEY_POINTER]);

      const nonsense = errorsOf(await validate(withKey({ schemaFormat: "application/x-nonsense", schema: 12345 })));
      expect(nonsense.map((d) => [d.code, d.pointer])).toContainEqual(["KAFKA_KEY_SCHEMA_FORMAT_UNSUPPORTED", KEY_POINTER]);
      expect(nonsense.filter((d) => d.code === "KAFKA_KEY_SCHEMA_INVALID")).toEqual([]);
    });

    it("rejects a bare Avro record key (the shape the assembler used to emit) via the parser's own binding check", async () => {
      const errors = errorsOf(await validate(withKey({ type: "record", name: "K", fields: [] })));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((d) => d.pointer.endsWith("/bindings/kafka/key/type"))).toBe(true);
    });

    it("accepts a JSON Schema key on a JSON Schema Kafka channel", async () => {
      const document = keyedDocument(
        { format: "json-schema", dialect: "draft-07", schema: { type: "object", properties: { id: { type: "string" } } } },
        jsonDraft07Channel,
      );
      expect(errorsOf(await validate(document))).toEqual([]);
    });
  });

  describe("embedded JSON Schema $ref rebasing (plan decision D8)", () => {
    it("accepts a draft-07 payload whose refs the assembler rebased onto the document", async () => {
      const document = jsonPayloadDocument(DRAFT_07_WITH_DEFINITIONS);
      const payload = (document.components as { messages: { M: { payload: JsonObject } } }).messages.M.payload;
      expect(payload.schema).toMatchObject({
        properties: { a: { $ref: "#/components/messages/M/payload/schema/definitions/A" } },
      });
      expect(errorsOf(await validate(document))).toEqual([]);
    });

    it("accepts a 2020-12 payload down-converted for a draft-07 channel ($defs -> definitions, rebased)", async () => {
      expect(errorsOf(await validate(jsonPayloadDocument(DRAFT_2020_12_WITH_DEFS)))).toEqual([]);
    });

    it("really resolves the rebased ref (the parsed document carries the referenced definition)", async () => {
      const output = await createAsyncApiParser().parse(JSON.stringify(jsonPayloadDocument(DRAFT_07_WITH_DEFINITIONS)));
      expect(output.diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error)).toEqual([]);
      const parsed = output.document?.json() as unknown as ParsedMessagePayload;
      expect(parsed.components.messages.M.payload.schema.properties.a).toMatchObject({ type: "string" });
    });

    it("control: the same document with an un-rebased ref is rejected", async () => {
      const document = jsonPayloadDocument(DRAFT_07_WITH_DEFINITIONS);
      const schema = (document.components as { messages: { M: { payload: { schema: JsonObject } } } }).messages.M
        .payload.schema;
      (schema.properties as { a: JsonObject }).a = { $ref: "#/definitions/A" };
      const errors = errorsOf(await validate(document));
      expect(errors.map((d) => [d.code, d.pointer])).toContainEqual([
        "invalid-ref",
        "/components/messages/M/payload/schema/properties/a/$ref",
      ]);
    });
  });

  describe("$ref rebasing is schema-position aware (properties named like data keywords)", () => {
    const REF = { $ref: "#/definitions/A" };
    const NAMED_PROPERTIES: SchemaArtifact = {
      format: "json-schema",
      dialect: "draft-07",
      schema: {
        type: "object",
        properties: { default: REF, enum: REF, ok: REF },
        definitions: { A: { type: "string" } },
      },
    };
    const NAMED_HEADERS: SchemaArtifact = {
      format: "json-schema",
      dialect: "draft-07",
      schema: {
        type: "object",
        properties: { default: { $ref: "#/definitions/H" }, const: { $ref: "#/definitions/H" } },
        definitions: { H: { type: "string" } },
      },
    };

    function namedPropertiesDocument(): JsonObject {
      return assembleAsyncApi3(
        spec({
          channels: [jsonDraft07Channel],
          messages: [message({ id: "m", name: "M", payloads: [NAMED_PROPERTIES], headers: NAMED_HEADERS })],
          operations: [operation({ key: "o", channelRef: jsonDraft07Channel.id, messageRefs: ["m"] })],
        }),
      ).document;
    }

    it("rebases the $ref of properties called default / enum / const as it does any other", () => {
      const message = (namedPropertiesDocument().components as { messages: { M: JsonObject } }).messages.M;
      const rebased = { $ref: "#/components/messages/M/payload/schema/definitions/A" };
      expect((message.payload as { schema: JsonObject }).schema.properties).toEqual({
        default: rebased,
        enum: rebased,
        ok: rebased,
      });
      const headerRef = { $ref: "#/components/messages/M/headers/definitions/H" };
      expect((message.headers as JsonObject).properties).toEqual({ default: headerRef, const: headerRef });
    });

    it("the assembled document passes the structural validator (no UNRESOLVED_REF)", () => {
      expect(validateAsyncApi3Structure(namedPropertiesDocument())).toEqual([]);
    });

    it("the assembled document passes the real parser with zero errors and resolves the refs", async () => {
      const document = namedPropertiesDocument();
      expect(errorsOf(await validate(document))).toEqual([]);
      const output = await createAsyncApiParser().parse(JSON.stringify(document));
      const parsed = output.document?.json() as unknown as {
        components: { messages: { M: { payload: { schema: { properties: Record<string, JsonObject> } } } } };
      };
      const properties = parsed.components.messages.M.payload.schema.properties;
      for (const name of ["default", "enum", "ok"]) expect(properties[name]).toMatchObject({ type: "string" });
    });

    it("a $ref sibling wrapped for draft-07 still resolves and validates (structural + parser)", async () => {
      const document = jsonPayloadDocument({
        format: "json-schema",
        dialect: "2020-12",
        schema: {
          type: "object",
          properties: { name: { $ref: "#/$defs/Name", maxLength: 3, description: "Short name" } },
          $defs: { Name: { type: "string" } },
        },
      });
      const schema = (document.components as { messages: { M: { payload: { schema: JsonObject } } } }).messages.M
        .payload.schema;
      expect((schema.properties as { name: JsonObject }).name).toEqual({
        description: "Short name",
        allOf: [{ $ref: "#/components/messages/M/payload/schema/definitions/Name" }, { maxLength: 3 }],
      });
      expect(validateAsyncApi3Structure(document)).toEqual([]);
      expect(errorsOf(await validate(document))).toEqual([]);
    });
  });

  describe("every payload format in one document", () => {
    it("validates Avro, JSON Schema (both dialects) and Protobuf copies of one message", async () => {
      const everyFormat: SchemaArtifact[] = [
        { format: "avro", schema: { type: "record", name: "OrderCreated", namespace: "acme.test", fields: [] } },
        { format: "json-schema", dialect: "draft-07", schema: { type: "object", properties: {} } },
        { format: "json-schema", dialect: "2020-12", schema: { type: "object", properties: {} } },
        {
          format: "protobuf",
          schema: 'syntax = "proto3";\n// @RootNode\nmessage OrderCreated {\n  string id = 1;\n}\n',
        },
      ];
      const channels = [
        channel({ id: "ch-avro", name: "orders-avro", profile: { format: "avro" } }),
        channel({ id: "ch-json", name: "orders-json", profile: { format: "json-schema" } }),
        channel({ id: "ch-json2020", name: "orders-json2020", profile: { format: "json-schema", dialect: "2020-12" } }),
        channel({ id: "ch-proto", name: "orders-proto", profile: { format: "protobuf" } }),
      ];
      const { document, diagnostics: assembled } = assembleAsyncApi3(
        spec({
          channels,
          messages: [message({ id: "m", name: "OrderCreated", payloads: everyFormat })],
          operations: channels.map((c) => operation({ key: `send-${c.id}`, channelRef: c.id, messageRefs: ["m"] })),
        }),
      );
      expect(errorsOf(assembled)).toEqual([]);
      expect(Object.keys((document.components as { messages: JsonObject }).messages)).toEqual([
        "OrderCreated_avro",
        "OrderCreated_json",
        "OrderCreated_json2020",
        "OrderCreated_proto",
      ]);
      const diagnostics = await validate(document);
      expect(errorsOf(diagnostics)).toEqual([]);
      // the 2020-12 copy is the only one the parser cannot look at — and it says so
      expect(diagnostics.filter((d) => d.code === "PAYLOAD_NOT_VALIDATED").map((d) => [d.severity, d.pointer])).toEqual([
        ["warning", "/components/messages/OrderCreated_json2020/payload"],
      ]);
    });
  });

  describe("JSON Schema 2020-12 payloads (no schema parser in @asyncapi/parser)", () => {
    const channel2020 = channel({
      id: "ch-2020",
      name: "orders-2020",
      profile: { format: "json-schema", dialect: "2020-12" },
    });
    const documentWith2020Payload = (schema: JsonObject): JsonObject =>
      assembleAsyncApi3(
        spec({
          channels: [channel2020],
          messages: [message({ id: "m", name: "M", payloads: [{ format: "json-schema", dialect: "2020-12", schema }] })],
          operations: [operation({ key: "o", channelRef: channel2020.id, messageRefs: ["m"] })],
        }),
      ).document;
    const notValidated = (list: Diagnostic[]) => list.filter((d) => d.code === "PAYLOAD_NOT_VALIDATED");

    it("a valid 2020-12 payload is not reported as clean: PAYLOAD_NOT_VALIDATED warning at the payload", async () => {
      const diagnostics = await validate(
        documentWith2020Payload({
          type: "object",
          properties: { a: { $ref: "#/$defs/A" } },
          $defs: { A: { type: "string" } },
          unevaluatedProperties: false,
        }),
      );
      expect(errorsOf(diagnostics)).toEqual([]);
      expect(notValidated(diagnostics)).toEqual([
        expect.objectContaining({ severity: "warning", pointer: "/components/messages/M/payload" }),
      ]);
      expect(notValidated(diagnostics)[0].message).toContain("NOT validated");
    });

    it("an invalid 2020-12 payload is flagged the same way (the warning is the only claim: it was not checked)", async () => {
      const diagnostics = await validate(documentWith2020Payload({ type: "strng", minLength: -1 }));
      expect(errorsOf(diagnostics)).toEqual([]);
      expect(notValidated(diagnostics).map((d) => [d.severity, d.pointer])).toEqual([
        ["warning", "/components/messages/M/payload"],
      ]);
    });

    it("contrast: the same broken schema in draft-07 IS rejected by the parser", async () => {
      const document = jsonPayloadDocument({
        format: "json-schema",
        dialect: "draft-07",
        schema: { type: "strng", minLength: -1 },
      });
      expect(errorsOf(await validate(document)).length).toBeGreaterThan(0);
      expect(notValidated(await validate(document))).toEqual([]);
    });

    it("2020-12 headers in a hand-written document are reported too, with the headers pointer", async () => {
      const document = documentWith2020Payload({ type: "object" });
      const msg = (document.components as { messages: { M: JsonObject } }).messages.M;
      msg.headers = {
        schemaFormat: "application/schema+json;version=2020-12",
        schema: { type: "object", properties: {} },
      };
      expect(notValidated(await validate(document)).map((d) => d.pointer)).toEqual([
        "/components/messages/M/headers",
        "/components/messages/M/payload",
      ]);
    });

    it("draft-07, Avro and Protobuf payloads never get the warning", async () => {
      expect(notValidated(await validate(jsonPayloadDocument(DRAFT_07_WITH_DEFINITIONS)))).toEqual([]);
      expect(notValidated(await validate(golden("checkout-service")))).toEqual([]);
    });
  });

  describe("negative cases", () => {
    it("reports an operation that references a missing channel, with a JSON pointer", async () => {
      const errors = errorsOf(await validate(documentWithMissingChannel()));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors).toContainEqual(
        expect.objectContaining({
          severity: "error",
          code: "invalid-ref",
          pointer: "/operations/publishOrderCreated/channel/$ref",
        }),
      );
      for (const d of errors) expect(d.message.length).toBeGreaterThan(0);
    });

    it("reports an Avro payload that is not a valid Avro schema", async () => {
      const doc = structuredClone(golden("checkout-service"));
      const payload = (doc.components as { messages: { OrderCreated: { payload: { schema: JsonObject } } } }).messages
        .OrderCreated.payload;
      payload.schema = { type: "record", name: "Order", fields: [{ name: "id", type: "no-such-type" }] };
      const errors = errorsOf(await validate(doc));
      expect(errors.length).toBeGreaterThan(0);
    });

    it("maps parser diagnostics: severity 0 error / 1 warning / 2,3 info, path -> RFC 6901 pointer", () => {
      const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
      const base = { code: "some-rule", message: "msg", path: ["channels", "a/b", "messages", 0], range };
      const pointer = "/channels/a~1b/messages/0";
      expect(mapParserDiagnostic({ ...base, severity: DiagnosticSeverity.Error })).toEqual({
        severity: "error",
        code: "some-rule",
        message: "msg",
        pointer,
      });
      expect(mapParserDiagnostic({ ...base, severity: DiagnosticSeverity.Warning }).severity).toBe("warning");
      expect(mapParserDiagnostic({ ...base, severity: DiagnosticSeverity.Information }).severity).toBe("info");
      expect(mapParserDiagnostic({ ...base, severity: DiagnosticSeverity.Hint }).severity).toBe("info");
      expect(mapParserDiagnostic({ ...base, code: 7, path: [], severity: DiagnosticSeverity.Error })).toMatchObject({
        code: "7",
        pointer: "",
      });
    });
  });

  describe("remote $ref resolution is disabled (SSRF)", () => {
    let server: Server;
    let hits: string[];
    let baseUrl: string;

    beforeAll(async () => {
      hits = [];
      server = createServer((req, res) => {
        hits.push(req.url ?? "");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ type: "string" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    function documentWithPropertyRef(ref: string): JsonObject {
      const document = jsonPayloadDocument(DRAFT_07_WITH_DEFINITIONS);
      const schema = (document.components as { messages: { M: { payload: { schema: JsonObject } } } }).messages.M
        .payload.schema;
      (schema.properties as { a: JsonObject }).a = { $ref: ref };
      return document;
    }

    it("validate() rejects a remote $ref up front and never fetches it", async () => {
      const errors = errorsOf(await validate(documentWithPropertyRef(`${baseUrl}/schema.json`)));
      expect(errors.map((d) => [d.code, d.pointer])).toEqual([
        ["REMOTE_REF", "/components/messages/M/payload/schema/properties/a"],
      ]);
      expect(hits).toEqual([]);
    });

    it("the parser itself is configured so that an http $ref is not fetched either", async () => {
      for (const ref of [`${baseUrl}/schema.json`, `${baseUrl}/schema.json#/definitions/A`]) {
        const output = await createAsyncApiParser().parse(JSON.stringify(documentWithPropertyRef(ref)));
        expect(output.document).toBeUndefined();
        expect(output.diagnostics.some((d) => d.severity === DiagnosticSeverity.Error)).toBe(true);
      }
      expect(hits).toEqual([]);
    });

    it("local-file $refs (a real file on disk) are blocked at the parser level and rejected by validate()", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "event-specs-ref-"));
      const file = path.join(dir, "schema.json");
      writeFileSync(file, JSON.stringify({ type: "string" }));
      try {
        // Control: a stock parser WOULD read this file, so the blocked parser failing is meaningful.
        const stock = await new Parser().parse(JSON.stringify(documentWithPropertyRef(file)));
        expect(stock.document).toBeDefined();

        for (const ref of [file, `file://${file}`, "./local-schema.json"]) {
          const document = documentWithPropertyRef(ref);
          const output = await createAsyncApiParser().parse(JSON.stringify(document));
          expect(output.document).toBeUndefined();
          expect(output.diagnostics.some((d) => d.severity === DiagnosticSeverity.Error)).toBe(true);
          expect(errorsOf(await validate(document)).map((d) => d.code)).toEqual(["REMOTE_REF"]);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("an unreadable file: $ref is rejected too", async () => {
      for (const ref of ["file:///etc/hostname"]) {
        const document = documentWithPropertyRef(ref);
        const output = await createAsyncApiParser().parse(JSON.stringify(document));
        expect(output.document).toBeUndefined();
        expect(output.diagnostics.some((d) => d.severity === DiagnosticSeverity.Error)).toBe(true);
        expect(errorsOf(await validate(document)).map((d) => d.code)).toEqual(["REMOTE_REF"]);
      }
    });
  });

  describe("a crash of the parser itself", () => {
    /** A validator whose parser is replaced (the field is private; `validate()` only creates one when it is unset). */
    function validatorWithParser(parse: () => Promise<never>): AsyncApiParserValidator {
      const v = new AsyncApiParserValidator();
      (v as unknown as { parser: { parse: () => Promise<never> } }).parser = { parse };
      return v;
    }

    it("returns ASYNCAPI_PARSER_FAILED with a generic message and logs the original exception server-side", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const raw = new Error("Spectral ruleset blew up near /srv/app/node_modules/@stoplight/spectral-core/index.js with postgres://admin:s3cret@db/app");
        const res = await validatorWithParser(() => Promise.reject(raw)).validate(golden("checkout-service"));
        expect(res).toEqual({ success: false, error: { code: "ASYNCAPI_PARSER_FAILED", message: GENERIC_VALIDATION_FAILURE } });
        expect(JSON.stringify(res)).not.toMatch(/Spectral|s3cret|node_modules|postgres:/);
        expect(consoleError).toHaveBeenCalledTimes(1);
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("ASYNCAPI_PARSER_FAILED"), raw);

        // A non-Error rejection is sanitized the same way.
        const primitive = await validatorWithParser(() => Promise.reject("raw s3cret")).validate(golden("checkout-service"));
        expect(primitive).toEqual({ success: false, error: { code: "ASYNCAPI_PARSER_FAILED", message: GENERIC_VALIDATION_FAILURE } });
        expect(consoleError).toHaveBeenLastCalledWith(expect.stringContaining("ASYNCAPI_PARSER_FAILED"), "raw s3cret");
      } finally {
        consoleError.mockRestore();
      }
    });

    it("keeps the generic message when the failure flows through the adapter (what emitDraft / toActionResult forward to the browser)", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const adapter = new AsyncApi3Adapter({ validators: [validatorWithParser(() => Promise.reject(new Error("raw parser text s3cret")))] });
        const emitted = await adapter.emit(checkoutServiceSpec);
        expect(emitted).toEqual({ success: false, error: { code: "ASYNCAPI_PARSER_FAILED", message: GENERIC_VALIDATION_FAILURE } });
        expect(JSON.stringify(emitted)).not.toContain("s3cret");
      } finally {
        consoleError.mockRestore();
      }
    });
  });

  describe("adapter wiring", () => {
    it("is opt-in: the default adapter stays structural, validators can be swapped or combined", async () => {
      const broken = documentWithMissingChannel();

      const structural = await new AsyncApi3Adapter().validate(broken);
      expect(structural.success && structural.data.map((d) => d.code)).toContain("UNRESOLVED_REF");
      expect(structural.success && structural.data.map((d) => d.code)).not.toContain("invalid-ref");

      const parserOnly = await new AsyncApi3Adapter({ validators: [new AsyncApiParserValidator()] }).validate(broken);
      expect(parserOnly.success && parserOnly.data.map((d) => d.code)).toContain("invalid-ref");
      expect(parserOnly.success && parserOnly.data.map((d) => d.code)).not.toContain("UNRESOLVED_REF");

      const both = await new AsyncApi3Adapter({
        validators: [new StructuralAsyncApi3Validator(), new AsyncApiParserValidator()],
      }).validate(broken);
      expect(both.success && both.data.map((d) => d.code)).toEqual(
        expect.arrayContaining(["UNRESOLVED_REF", "invalid-ref"]),
      );
    });

    it("emit() with the parser validator returns the document, JSON, YAML and no error diagnostics", async () => {
      const adapter = new AsyncApi3Adapter({ validators: [new AsyncApiParserValidator()] });
      const res = await adapter.emit(checkoutServiceSpec);
      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(errorsOf(res.data.diagnostics)).toEqual([]);
      expect(JSON.parse(res.data.json)).toEqual(res.data.document);
    });

    it("emit() surfaces parser errors as diagnostics instead of failing", async () => {
      const adapter = new AsyncApi3Adapter({ validators: [new AsyncApiParserValidator()] });
      const bad = spec({
        productSlug: "checkout",
        info: { title: "bad", version: "1.0" },
        channels: [jsonDraft07Channel],
        messages: [
          message({
            id: "m",
            name: "M",
            payloads: [
              {
                format: "json-schema",
                dialect: "draft-07",
                schema: { type: "object", properties: { a: { $ref: "https://example.invalid/a.json" } } },
              },
            ],
          }),
        ],
        operations: [operation({ key: "o", channelRef: jsonDraft07Channel.id, messageRefs: ["m"] })],
      });
      const res = await adapter.emit(bad);
      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data.diagnostics.map((d) => d.code)).toContain("REMOTE_REF");
    });
  });
});
