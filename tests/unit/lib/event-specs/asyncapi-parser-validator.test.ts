import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiagnosticSeverity, Parser } from "@asyncapi/parser";
import { AsyncApi3Adapter } from "@/lib/event-specs/adapter";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import { StructuralAsyncApi3Validator } from "@/lib/event-specs/validator";
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
      for (const d of diagnostics) expect(d.pointer === "" || d.pointer.startsWith("/")).toBe(true);
    });

    it("exposes the validator name", () => {
      expect(validator.name).toBe("asyncapi-parser");
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
      expect(errorsOf(await validate(document))).toEqual([]);
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
