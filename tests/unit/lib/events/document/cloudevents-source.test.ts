import { describe, expect, it } from "vitest";
import { parseEventDocument } from "@/lib/events/document/parse";
import { classifyEventBump } from "@/lib/events/document/bump";
import { runPipeline } from "./fixtures/compat-pipeline";
import { maximalArtifacts, maximalDocument } from "./fixtures/maximal-document";

describe("event CloudEvents source", () => {
  it("survives parse and is emitted as info.x-cloudevents-source; absent stays absent", () => {
    const doc = { ...maximalDocument(), cloudEventsSource: "urn:app:accounts-service" };
    const parsed = parseEventDocument(doc);
    expect(parsed.success && parsed.data.cloudEventsSource).toBe("urn:app:accounts-service");
    const { document } = runPipeline(doc, maximalArtifacts());
    expect((document.info as Record<string, unknown>)["x-cloudevents-source"]).toBe("urn:app:accounts-service");
    expect((runPipeline(maximalDocument(), maximalArtifacts()).document.info as Record<string, unknown>)["x-cloudevents-source"]).toBeUndefined();
  });
  it("a changed source is a minor version change", () => {
    const prev = maximalDocument();
    const side = (doc: typeof prev) => ({ doc, pins: {}, libraryHeaders: {}, externalMajors: {} }) as unknown as Parameters<typeof classifyEventBump>[0];
    const decision = classifyEventBump(side(prev), side({ ...prev, cloudEventsSource: "urn:app:x" }));
    expect(JSON.stringify(decision)).toMatch(/CloudEvents source changed/);
    expect(JSON.stringify(decision)).toMatch(/minor/i);
  });
});
