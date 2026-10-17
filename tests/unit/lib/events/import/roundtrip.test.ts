// tests/unit/lib/events/import/roundtrip.test.ts
// WP-I1, Review Focus 4: an AsyncAPI document emitted by this app imports back into an equivalent event document. The originals are the
// event documents behind our own golden files (slice 1) and the maximal document; what "equivalent" means is `comparableDocument`.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toYaml } from "@/lib/event-specs/serialize";
import type { JsonObject } from "@/lib/event-specs/types";
import { parseEventDocument } from "@/lib/events/document/parse";
import type { EventDocument } from "@/lib/events/document/types";
import { extractPayloads } from "@/lib/events/import/payloads";
import { mapAsyncApiToEventDocument } from "@/lib/events/import/map-document";
import { parseAsyncApiSource } from "@/lib/events/import/source";
import type { RawAsyncApi3 } from "@/lib/events/import/types";
import { artifactsFor, runPipeline } from "../document/fixtures/compat-pipeline";
import { maximalArtifacts, maximalDocument } from "../document/fixtures/maximal-document";
import { demoCheckoutService, demoFraudScorer, demoReturnsService, libraryTraits, slice1KitchenSink, slice1Minimal } from "../document/fixtures/slice1-documents";
import { comparableDocument } from "./comparable-document";

/** The three messages of the channel-protocol guess (map-document.ts), by their exact beginnings. */
const PROTOCOL_GUESS = /^(This channel is on servers with different protocols|This channel names no server and the document's servers use different protocols|Nothing in the document tells the protocol of this channel)/;

const SLICE1_GOLDEN_DIR = path.join(process.cwd(), "tests/unit/lib/events/document/__golden__");
const V1_GOLDEN_DIR = path.join(process.cwd(), "tests/unit/lib/event-specs/__golden__");

/** The event document each slice-1 golden file was emitted from. */
const ORIGINALS: Record<string, () => EventDocument> = {
  "slice1-minimal": slice1Minimal,
  "slice1-demo-checkout-service": demoCheckoutService,
  "slice1-demo-fraud-scorer": demoFraudScorer,
  "slice1-demo-returns-service": demoReturnsService,
  "slice1-kitchen-sink": slice1KitchenSink,
};

/** text → source → extract → fake pins → map: the whole pure pipeline, the way the importer will drive it. */
function importText(text: string) {
  const parsed = parseAsyncApiSource(text);
  if (!parsed.success) throw new Error(`source: ${parsed.error.code}: ${parsed.error.message}`);
  const raw: RawAsyncApi3 = parsed.data;
  const extracted = extractPayloads(raw);
  if (!extracted.success) throw new Error(`extract: ${extracted.error.code}: ${extracted.error.message}`);
  const payloadPins = new Map(extracted.data.map((p) => [`${p.messageKey}:${p.role}`, { entityId: `ent:${p.messageKey}:${p.role}`, entityVersionId: null }]));
  const mapped = mapAsyncApiToEventDocument(raw, { payloadPins, builtInTraitIds: {} });
  if (!mapped.success) throw new Error(`map: ${mapped.error.code}: ${mapped.error.message}`);
  return { raw, extracted: extracted.data, ...mapped.data };
}

describe("round trip: our own slice-1 golden files", () => {
  const files = readdirSync(SLICE1_GOLDEN_DIR).filter((f) => /^slice1-.*\.asyncapi\.yaml$/.test(f)).map((f) => f.replace(/\.asyncapi\.yaml$/, "")).sort();

  it("covers every golden file there is (a new golden must be given its original here)", () => {
    expect(files).toEqual(Object.keys(ORIGINALS).sort());
  });

  describe.each(files)("%s", (name) => {
    const original = () => ORIGINALS[name]();
    const compare = (text: string) => {
      const imported = importText(text);
      // those goldens were emitted without `channels.<c>.servers`, so the links and the protocol are not in the file
      const options = { serverLinks: false, reachableOnly: true, libraryTraits: libraryTraits() };
      expect(comparableDocument(imported.document, options)).toEqual(comparableDocument(original(), options));
      return imported;
    };

    it("imports from the YAML golden into an equivalent event document that parses", () => {
      const imported = compare(readFileSync(path.join(SLICE1_GOLDEN_DIR, `${name}.asyncapi.yaml`), "utf8"));
      expect(parseEventDocument(imported.document).success).toBe(true);
    });

    it("imports from the JSON golden into the same document", () => {
      const fromJson = importText(readFileSync(path.join(SLICE1_GOLDEN_DIR, `${name}.asyncapi.json`), "utf8"));
      const fromYaml = importText(readFileSync(path.join(SLICE1_GOLDEN_DIR, `${name}.asyncapi.yaml`), "utf8"));
      expect(fromJson.document).toEqual(fromYaml.document);
      expect(fromJson.warnings).toEqual(fromYaml.warnings);
    });

    it("reports nothing it should not: no unsupported formats, no sanitising, no dropped parts; a protocol it had to guess is the one thing it says", () => {
      const { warnings } = importText(readFileSync(path.join(SLICE1_GOLDEN_DIR, `${name}.asyncapi.yaml`), "utf8"));
      const unexpected = warnings.filter((w) => !(w.code === "KEY_ADJUSTED" || (w.code === "SANITIZED_VALUE" && PROTOCOL_GUESS.test(w.message))));
      expect(unexpected).toEqual([]);
    });
  });

  it("those goldens carry no channel -> server links, so a channel with no bindings in a document with two protocols is reported as guessed", () => {
    const guesses = (name: string) => importText(readFileSync(path.join(SLICE1_GOLDEN_DIR, `${name}.asyncapi.yaml`), "utf8")).warnings.filter((w) => PROTOCOL_GUESS.test(w.message)).map((w) => w.pointer);
    expect(guesses("slice1-demo-checkout-service")).toEqual(["/channels/customer-orders"]);
    expect(guesses("slice1-demo-fraud-scorer").sort()).toEqual(["/channels/fraud-scores", "/channels/orders"]);
    expect(guesses("slice1-minimal")).toEqual([]);
    expect(guesses("slice1-kitchen-sink")).toEqual([]);
  });

  it("the comparison is not vacuous: it sees a changed summary, a lost operation and a different key", () => {
    const imported = importText(readFileSync(path.join(SLICE1_GOLDEN_DIR, "slice1-kitchen-sink.asyncapi.yaml"), "utf8")).document;
    const options = { serverLinks: false, reachableOnly: true, libraryTraits: libraryTraits() };
    const expected = comparableDocument(slice1KitchenSink(), options);
    expect(comparableDocument(imported, options)).toEqual(expected);
    const summary = structuredClone(imported);
    summary.messages[0].summary = "changed";
    expect(comparableDocument(summary, options)).not.toEqual(expected);
    const lost = structuredClone(imported);
    lost.operations.pop();
    expect(comparableDocument(lost, options)).not.toEqual(expected);
    const renamed = structuredClone(imported);
    renamed.channels[0].key = "other";
    expect(comparableDocument(renamed, options)).not.toEqual(expected);
    const comparable = expected as { servers: unknown[]; channels: unknown[]; messages: unknown[]; operations: unknown[]; traits: unknown[] };
    expect([comparable.servers.length, comparable.channels.length, comparable.messages.length, comparable.operations.length, comparable.traits.length]).toEqual([2, 2, 2, 2, 2]);
  });

  it("extracts one payload per emitted message, the format-suffixed variants included", () => {
    const { extracted } = importText(readFileSync(path.join(SLICE1_GOLDEN_DIR, "slice1-kitchen-sink.asyncapi.yaml"), "utf8"));
    expect(extracted.map((p) => `${p.messageKey}:${p.role}:${p.format}`).sort()).toEqual([
      "OrderCreated:payload:avro", "OrderSummary_avro:payload:avro", "OrderSummary_json:payload:json-schema",
    ]);
  });
});

describe("round trip: the maximal document, emitted through the assembler", () => {
  const emitted = (): JsonObject => runPipeline(maximalDocument(), { ...maximalArtifacts(), emitChannelServers: true }).document;

  it("imports into an equivalent event document, channel servers and every AsyncAPI property included", () => {
    const imported = importText(toYaml(emitted()));
    expect(comparableDocument(imported.document, { libraryTraits: libraryTraits() })).toEqual(comparableDocument(maximalDocument(), { libraryTraits: libraryTraits() }));
    expect(parseEventDocument(imported.document).success).toBe(true);
  });

  it("imports the same from the JSON form, and with no warning at all", () => {
    const fromJson = importText(JSON.stringify(emitted()));
    const fromYaml = importText(toYaml(emitted()));
    expect(fromJson.document).toEqual(fromYaml.document);
    // the multi-format message is the only thing the importer has to explain: it arrives as two messages
    expect(fromYaml.warnings).toEqual([]);
  });

  it("a message the assembler wrote in two formats arrives as two messages, each pointing at its own channel", () => {
    const { document } = importText(toYaml(emitted()));
    expect(document.messages.map((m) => m.key).sort()).toEqual(["OrderCreated", "OrderSummary_avro", "OrderSummary_json"]);
    expect(document.channels.find((c) => c.key === "orders")?.messageKeys).toEqual(["OrderCreated", "OrderSummary_avro"]);
    expect(document.channels.find((c) => c.key === "replies")?.messageKeys).toEqual(["OrderSummary_json"]);
  });

  it("keeps the Kafka key schema where the assembler put it, as the message's own binding", () => {
    const { document } = importText(toYaml(emitted()));
    const bindings = document.messages.find((m) => m.key === "OrderCreated")?.bindings as { kafka: { key: { schemaFormat: string; schema: { name: string } } } };
    expect(bindings.kafka.key.schemaFormat).toMatch(/avro/);
    expect(bindings.kafka.key.schema.name).toBe("OrderCreatedKey");
  });

  it("extracts payloads and headers of the maximal document in their formats", () => {
    const { extracted } = importText(toYaml(emitted()));
    expect(extracted.map((p) => `${p.messageKey}:${p.role}:${p.format}`).sort()).toEqual([
      "OrderCreated:headers:json-schema", "OrderCreated:payload:avro", "OrderSummary_avro:payload:avro", "OrderSummary_json:payload:json-schema",
    ]);
  });
});

describe("round trip: the assembler's older goldens (no event document behind them)", () => {
  const files = readdirSync(V1_GOLDEN_DIR).filter((f) => f.endsWith(".asyncapi.yaml")).sort();

  it("has the goldens this test expects", () => {
    expect(files).toEqual(["checkout-service.asyncapi.yaml", "fraud-scorer.asyncapi.yaml"]);
  });

  it.each(files)("%s imports into a document that parses and describes the same servers, channels, messages and operations", (file) => {
    const imported = importText(readFileSync(path.join(V1_GOLDEN_DIR, file), "utf8"));
    const raw = imported.raw as { servers?: object; channels?: Record<string, { address: string }>; operations?: Record<string, { action: string }>; components?: { messages?: object; messageTraits?: object; operationTraits?: object } };
    expect(parseEventDocument(imported.document).success).toBe(true);
    expect(imported.document.servers.map((s) => s.key).sort()).toEqual(Object.keys(raw.servers ?? {}).sort());
    expect(imported.document.channels.map((c) => [c.key, c.address]).sort()).toEqual(Object.entries(raw.channels ?? {}).map(([key, c]) => [key, c.address]).sort());
    expect(imported.document.operations.map((o) => [o.key, o.action]).sort()).toEqual(Object.entries(raw.operations ?? {}).map(([key, o]) => [key, o.action]).sort());
    expect(imported.document.messages.map((m) => m.key).sort()).toEqual(Object.keys(raw.components?.messages ?? {}).sort());
    expect(imported.document.traits.map((t) => t.key).sort()).toEqual([...Object.keys(raw.components?.messageTraits ?? {}), ...Object.keys(raw.components?.operationTraits ?? {})].sort());
    expect(imported.warnings).toEqual([]);
  });
});

describe("the imported documents are usable downstream", () => {
  const DIR = path.join(process.cwd(), "tests/fixtures/asyncapi-import");
  const files = readdirSync(DIR).filter((f) => /\.(ya?ml|json)$/.test(f) && !f.startsWith("negative-")).sort();

  it.each(files)("%s: the assembler emits the imported document again, without an error, and importing THAT gives the same document", (file) => {
    const first = importText(readFileSync(path.join(DIR, file), "utf8"));
    // the stand-in renderer supplies payloads only: give every pinned headers schema a rendering too
    const artifacts = artifactsFor(first.document, undefined, { emitAll: true });
    for (const m of first.document.messages) {
      const rendered = artifacts.get(m.key);
      if (m.headers && rendered) artifacts.set(m.key, { ...rendered, headers: { format: "json-schema", dialect: "draft-07", schema: { type: "object", properties: { id: { type: "string" } } } } });
    }
    const again = runPipeline(first.document, { artifacts, emitChannelServers: true, emitAll: true });
    expect(again.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const second = importText(toYaml(again.document));
    expect(comparableDocument(second.document)).toEqual(comparableDocument(first.document));
  });
});
