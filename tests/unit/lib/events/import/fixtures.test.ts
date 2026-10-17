// tests/unit/lib/events/import/fixtures.test.ts
// WP-I1: the hand-written AsyncAPI 3.0 fixtures (reused by WP-I2 / WP-I3) are valid per the real @asyncapi/parser, and the negatives are
// rejected somewhere on the way.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAsyncApiParser } from "@/lib/event-specs/validation/asyncapi-parser-validator";
import * as importer from "@/lib/events/import";
import { parseAsyncApiSource } from "@/lib/events/import/source";

const DIR = path.join(process.cwd(), "tests/fixtures/asyncapi-import");
const read = (name: string) => readFileSync(path.join(DIR, name), "utf8");
const all = readdirSync(DIR).filter((f) => /\.(ya?ml|json)$/.test(f)).sort();
const negatives = all.filter((f) => f.startsWith("negative-"));
const positives = all.filter((f) => !f.startsWith("negative-"));

describe("fixtures", () => {
  it("lists the documents the plan asks for", () => {
    expect(positives).toEqual([
      "builtin-traits.yaml",
      "http-websocket-minimal.json",
      "inline-messages-and-traits.yaml",
      "multi-format-payloads.yaml",
      "recursive-payload-placeholder.yaml",
      "recursive-schemas.yaml",
      "request-reply.yaml",
      "streetlights-kafka.yaml",
      "streetlights-mqtt.yaml",
      "unsupported-payloads.yaml",
    ]);
    expect(negatives).toEqual([
      "negative-alias-bomb.yaml",
      "negative-asyncapi-2x.yaml",
      "negative-external-ref.yaml",
      "negative-missing-ref.yaml",
      "negative-proto-key.yaml",
      "negative-ref-cycle-trait-message.yaml",
    ]);
  });

  it.each(positives)("%s is read by parseAsyncApiSource", (name) => {
    const result = parseAsyncApiSource(read(name));
    expect(result.success).toBe(true);
  });

  it.each(positives)("%s is valid per @asyncapi/parser (no errors)", async (name) => {
    const { diagnostics } = await createAsyncApiParser().parse(read(name));
    const errors = diagnostics.filter((d) => d.severity === 0).map((d) => `${d.code}: ${d.message} at /${(d.path ?? []).join("/")}`);
    expect(errors).toEqual([]);
  }, 60_000);

  it.each(negatives)("%s is never imported as is", (name) => {
    const parsed = parseAsyncApiSource(read(name));
    // The ref negatives parse fine. External and missing refs and a message <-> trait cycle are rejected when read (refs.test.ts /
    // map-document.test.ts); a recursive PAYLOAD schema (`recursive-payload-placeholder.yaml`, `recursive-schemas.yaml`) is not refused: that payload becomes a placeholder.
    if (/ref/.test(name)) expect(parsed.success).toBe(true);
    else expect(parsed.success).toBe(false);
  });

  it("the importer's index exports the whole pure surface", () => {
    expect(Object.keys(importer).sort()).toEqual([
      "MAX_ALIAS_COUNT", "MAX_DOCUMENT_NODES", "MAX_EXPANDED_NODES", "MAX_NESTING_DEPTH", "createRefResolver", "detectBuiltInTrait",
      "extractPayloads", "mapAsyncApiToEventDocument", "parseAsyncApiSource", "pascalName", "resolveLocalRefs",
    ]);
  });
});
