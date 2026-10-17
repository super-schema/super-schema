// tests/unit/lib/events/import/message-index.test.ts
// WP-I1 fix round 5: channels that refer to one shared channel definition share its messages (the definition is walked once), and the number of
// channel x message pairs, which is what the event document stores, is capped.
import { describe, expect, it } from "vitest";
import { MAX_CHANNEL_MESSAGE_PAIRS } from "@/lib/events/import/limits";
import { mapAsyncApiToEventDocument } from "@/lib/events/import/map-document";
import { indexMessages } from "@/lib/events/import/message-index";
import { extractPayloads } from "@/lib/events/import/payloads";
import { createRefResolver } from "@/lib/events/import/refs";
import type { RawAsyncApi3 } from "@/lib/events/import/types";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const messagesOf = (n: number) => Object.fromEntries(range(n).map((i) => [`m${i}`, { payload: { type: "object" } }]));
/** `channels` channels that all refer to one component channel with `messages` messages. */
const shared = (channels: number, messages: number): RawAsyncApi3 => ({
  asyncapi: "3.0.0", info: { title: "T" }, servers: { s: { host: "h:1", protocol: "kafka" } },
  channels: Object.fromEntries(range(channels).map((i) => [`c${i}`, { $ref: "#/components/channels/big" }])),
  components: { channels: { big: { address: "a", messages: messagesOf(messages) } } },
});
const index = (raw: RawAsyncApi3) => indexMessages(raw, createRefResolver(raw));

describe("indexMessages: a shared channel definition is walked once", () => {
  it("channels that refer to one component channel share one map of messages, and its messages appear once", () => {
    const result = index(shared(3, 4));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.messages.map((m) => m.key)).toEqual(["m0", "m1", "m2", "m3"]);
    const [first, second, third] = ["c0", "c1", "c2"].map((c) => result.data.channels.get(c));
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect([...(first?.keys() ?? [])]).toEqual(["m0", "m1", "m2", "m3"]);
    expect(result.data.messages.map((m) => m.pointer)).toEqual(range(4).map((i) => `/components/channels/big/messages/m${i}`));
  });

  it("channels that hold their own messages still get their own", () => {
    const raw: RawAsyncApi3 = { asyncapi: "3.0.0", info: { title: "T" }, channels: { a: { messages: messagesOf(2) }, b: { messages: messagesOf(3) } } };
    const result = index(raw);
    expect(result.success && result.data.messages.map((m) => [m.key, m.pointer])).toEqual([
      ["m0", "/channels/a/messages/m0"], ["m1", "/channels/a/messages/m1"], ["m0-2", "/channels/b/messages/m0"], ["m1-2", "/channels/b/messages/m1"], ["m2", "/channels/b/messages/m2"],
    ]);
  });

  it("key adjustments of a shared channel's messages are reported once, not once per channel", () => {
    const raw: RawAsyncApi3 = {
      asyncapi: "3.0.0", info: { title: "T" },
      channels: { a: { $ref: "#/components/channels/big" }, b: { $ref: "#/components/channels/big" } },
      components: { channels: { big: { messages: { "not valid": { payload: {} } } } } },
    };
    const result = index(raw);
    expect(result.success && result.data.warnings.map((w) => w.code)).toEqual(["KEY_ADJUSTED"]);
  });
});

describe("the cap on channel x message pairs (500,000)", () => {
  it("exactly at the cap is fine: 500 channels that share a channel of 1,000 messages", () => {
    expect(MAX_CHANNEL_MESSAGE_PAIRS).toBe(500_000);
    expect(index(shared(500, 1000)).success).toBe(true);
  });

  it("one pair over is REF_TOO_LARGE, with a bounded message that says what to do", () => {
    const result = index(shared(501, 1000));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("REF_TOO_LARGE");
    expect(result.error.message).toContain("500,000");
    expect(result.error.message.length).toBeLessThan(400);
    expect(result.error.suggestedFix).toMatch(/fewer channels/);
    expect(result.error.details).toMatchObject({ pointer: "/channels/c500", limit: 500_000 });
  });

  it("extractPayloads and the mapper refuse the same document, fast, whatever the shape of the sharing (95 x 50,000 and 240 x 20,000)", () => {
    for (const [channels, messages] of [[95, 50_000], [240, 20_000]]) {
      const raw = shared(channels, messages);
      const started = Date.now();
      const extracted = extractPayloads(raw);
      const mapped = mapAsyncApiToEventDocument(raw, { payloadPins: new Map(), builtInTraitIds: {} });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(extracted.success ? "ok" : extracted.error.code).toBe("REF_TOO_LARGE");
      expect(mapped.success ? "ok" : mapped.error.code).toBe("REF_TOO_LARGE");
    }
  }, 30_000);

  it("a document under the cap maps, every channel with the shared channel's messages", () => {
    const raw = shared(3, 5);
    const extracted = extractPayloads(raw);
    expect(extracted.success).toBe(true);
    if (!extracted.success) return;
    const payloadPins = new Map(extracted.data.map((p) => [`${p.messageKey}:${p.role}`, { entityId: `e${p.messageKey}`, entityVersionId: null }]));
    const mapped = mapAsyncApiToEventDocument(raw, { payloadPins, builtInTraitIds: {} });
    expect(mapped.success).toBe(true);
    if (!mapped.success) return;
    expect(mapped.data.document.messages).toHaveLength(5);
    expect(mapped.data.document.channels.map((c) => c.messageKeys)).toEqual([range(5).map((i) => `m${i}`), range(5).map((i) => `m${i}`), range(5).map((i) => `m${i}`)]);
  });
});
