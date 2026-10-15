import { describe, it, expect } from "vitest";
import { collectDocumentRefs, emptyEventSpecDocument, parseEventSpecDocument } from "@/lib/events/event-spec-document";

const op = (over: Record<string, unknown> = {}) => ({
  key: "publishOrderCreated", action: "send", channelId: "ch1", messageVersionIds: ["mv1"], traitIds: [], ...over,
});

describe("EventSpecDocument", () => {
  it("creates an empty draft", () => {
    expect(emptyEventSpecDocument("checkout-service")).toEqual({ info: { title: "checkout-service" }, servers: [], operations: [] });
  });

  it("normalizes a valid document and drops unknown keys", () => {
    const r = parseEventSpecDocument({
      info: { title: " checkout-service ", description: "d", junk: 1 },
      servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka:9092" }],
      operations: [op({ reply: { channelId: "ch2" } })],
      defaultContentType: "application/json",
    });
    expect(r).toEqual({
      success: true,
      data: {
        info: { title: "checkout-service", description: "d" },
        defaultContentType: "application/json",
        servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka:9092" }],
        operations: [{ key: "publishOrderCreated", action: "send", channelId: "ch1", messageVersionIds: ["mv1"], traitIds: [], reply: { channelId: "ch2" } }],
      },
    });
  });

  it("reports every problem with a pointer into the draft", () => {
    const r = parseEventSpecDocument({
      info: { title: "" },
      servers: [{ key: "a b", protocol: "", host: "h" }],
      operations: [op(), op({ action: "publish", channelId: "" })],
    });
    expect(r.success).toBe(false);
    expect(!r.success && (r.error.details as { problems: unknown[] }).problems).toEqual([
      { pointer: "/info/title", message: "info.title is required" },
      { pointer: "/servers/0/key", message: 'Server key "a b" must match ^[A-Za-z0-9._-]+$' },
      { pointer: "/servers/0/protocol", message: "Server protocol is required" },
      { pointer: "/operations/1/key", message: 'Duplicate operation key "publishOrderCreated"' },
      { pointer: "/operations/1/action", message: 'Operation action must be "send" or "receive"' },
      { pointer: "/operations/1/channelId", message: "Operation channel is required" },
    ]);
  });

  it("collects channel, message and trait references in first-reference order", () => {
    const parsed = parseEventSpecDocument({
      info: { title: "x" },
      servers: [],
      operations: [
        op({ traitIds: ["t1"], reply: { channelId: "ch2", messageVersionIds: ["mv2"] } }),
        op({ key: "second", channelId: "ch2", messageVersionIds: ["mv1", "m-draft"], traitIds: ["t1", "t2"] }),
      ],
    });
    expect(parsed.success && collectDocumentRefs(parsed.data)).toEqual({
      channelIds: ["ch1", "ch2"],
      messageRefIds: ["mv1", "mv2", "m-draft"],
      traitIds: ["t1", "t2"],
    });
  });
});
