// tests/unit/lib/events/document/emission-compat.test.ts
// WP-1a backward compatibility: every document slice 1 could author still parses unchanged and resolves + emits
// byte-for-byte what it emitted before the document model grew. The goldens in __golden__/slice1-* were generated from the
// code BEFORE WP-1a changed it:  UPDATE_GOLDEN=1 npx vitest run tests/unit/lib/events/document/emission-compat.test.ts
// Regenerate deliberately and review the diff — a golden change here is an output-contract change.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toYaml } from "@/lib/event-specs/serialize";
import { validateAsyncApi3Structure } from "@/lib/event-specs/validator";
import { parseEventDocument } from "@/lib/events/document/parse";
import type { EventDocument } from "@/lib/events/document/types";
import { runPipeline } from "./fixtures/compat-pipeline";
import { demoCheckoutService, demoFraudScorer, demoReturnsService, slice1KitchenSink, slice1Minimal } from "./fixtures/slice1-documents";

const GOLDEN_DIR = path.join(__dirname, "__golden__");
const toJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function expectGolden(file: string, actual: string): void {
  const target = path.join(GOLDEN_DIR, file);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(target, actual);
  }
  expect(actual).toBe(readFileSync(target, "utf8"));
}

const FIXTURES: Array<[name: string, build: () => EventDocument]> = [
  ["minimal", slice1Minimal],
  ["demo-checkout-service", demoCheckoutService],
  ["demo-fraud-scorer", demoFraudScorer],
  ["demo-returns-service", demoReturnsService],
  ["kitchen-sink", slice1KitchenSink],
];

describe.each(FIXTURES)("slice-1 document %s", (name, build) => {
  it("parses to exactly the document that was authored (nothing added, dropped or reordered in meaning)", () => {
    const parsed = parseEventDocument(build());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(build());
  });

  it("resolves to the same ResolvedEventSpec as before (the resolved spec is stored with versions)", () => {
    expectGolden(`slice1-${name}.resolved.json`, toJson(runPipeline(build()).resolved));
  });

  it("emits the same AsyncAPI JSON and YAML byte-for-byte, with the same diagnostics", () => {
    const out = runPipeline(build());
    expectGolden(`slice1-${name}.asyncapi.json`, toJson(out.document));
    expectGolden(`slice1-${name}.asyncapi.yaml`, toYaml(out.document));
    expectGolden(`slice1-${name}.diagnostics.json`, toJson(out.diagnostics));
  });

  it("still passes the structural validator", () => {
    const errors = validateAsyncApi3Structure(runPipeline(build()).document).filter((d) => d.severity === "error");
    expect(errors).toEqual([]);
  });
});

describe("slice-1 emission details worth pinning explicitly", () => {
  it("does not emit channel servers, server extras or any other new key for a slice-1 document", () => {
    const { document } = runPipeline(demoCheckoutService());
    const channels = document.channels as Record<string, Record<string, unknown>>;
    expect(Object.keys(channels.orders)).toEqual(["address", "messages", "title", "description", "bindings"]);
    const servers = document.servers as Record<string, Record<string, unknown>>;
    expect(Object.keys(servers["kafka-prod"])).toEqual(["host", "protocol", "description"]);
    const operations = document.operations as Record<string, Record<string, unknown>>;
    expect(Object.keys(operations.publishOrderCreated)).toEqual(["action", "channel", "summary", "traits", "messages"]);
    expect(Object.keys(document)).toEqual(["asyncapi", "info", "servers", "defaultContentType", "channels", "operations", "components"]);
  });
});
