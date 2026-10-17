// tests/unit/lib/events/import/keys.test.ts
// WP-I1 fix round 4: key allocation is linear however many keys slug to the same base (20,000 of them took 40 s, 100,000 fit in 1 MiB).
import { describe, expect, it } from "vitest";
import { assignKeys, suggestTraitKey, uniqueIn } from "@/lib/events/import/keys";
import { mapAsyncApiToEventDocument } from "@/lib/events/import/map-document";
import { extractPayloads } from "@/lib/events/import/payloads";
import type { ImportWarning, RawAsyncApi3 } from "@/lib/events/import/types";

/** `a` followed by the digits of `i` written as punctuation: all different, all slug to `a`. */
const collidingKey = (i: number): string => `a${[...String(i)].map((d) => "!?#$%^&*()"[Number(d)]).join("")}`;

/** Adds what `uniqueIn` returned to `taken`, the way every caller does. */
function allocate(base: string, taken: Set<string>): string {
  const key = uniqueIn(base, taken);
  taken.add(key);
  return key;
}

describe("uniqueIn", () => {
  it("is the base when it is free, then base-2, base-3, … as they are taken", () => {
    const taken = new Set<string>();
    expect([1, 2, 3, 4].map(() => allocate("a", taken))).toEqual(["a", "a-2", "a-3", "a-4"]);
  });

  it("skips suffixes that are already taken, and never hands out one twice", () => {
    const taken = new Set(["a", "a-3", "a-4", "a-6"]);
    expect([1, 2, 3, 4].map(() => allocate("a", taken))).toEqual(["a-2", "a-5", "a-7", "a-8"]);
  });

  it("each base has its own sequence, and each `taken` set its own", () => {
    const first = new Set<string>();
    const second = new Set<string>();
    expect([allocate("a", first), allocate("b", first), allocate("a", first), allocate("b", first)]).toEqual(["a", "b", "a-2", "b-2"]);
    expect([allocate("a", second), allocate("a", second)]).toEqual(["a", "a-2"]);
  });

  it("a key that was added by someone else in between is respected", () => {
    const taken = new Set<string>();
    expect(allocate("a", taken)).toBe("a");
    expect(allocate("a", taken)).toBe("a-2");
    taken.add("a-3");
    expect(allocate("a", taken)).toBe("a-4");
  });

  it("keeps the result within 64 characters", () => {
    const base = "k".repeat(64);
    const taken = new Set<string>();
    const keys = [1, 2, 3].map(() => allocate(base, taken));
    expect(keys).toEqual([base, `${"k".repeat(62)}-2`, `${"k".repeat(62)}-3`]);
    expect(keys.every((k) => k.length <= 64)).toBe(true);
  });

  it("20,000 keys with the same base are allocated in a blink, all different, in order", () => {
    const taken = new Set<string>();
    const started = performance.now();
    const keys = Array.from({ length: 20_000 }, () => allocate("a", taken));
    expect(performance.now() - started).toBeLessThan(500);
    expect(new Set(keys).size).toBe(20_000);
    expect(keys.slice(0, 4)).toEqual(["a", "a-2", "a-3", "a-4"]);
    expect(keys[19_999]).toBe("a-20000");
  });
});

describe("assignKeys", () => {
  it("20,000 invalid keys that all slug to `a` get a, a-2, a-3, … fast, each with a warning", () => {
    const requests = Array.from({ length: 20_000 }, (_, i) => ({ id: `r${i}`, key: collidingKey(i), pointer: `/p/${i}` }));
    const warnings: ImportWarning[] = [];
    const started = performance.now();
    const assigned = assignKeys(requests, new Set(), "message", (w) => warnings.push(w));
    expect(performance.now() - started).toBeLessThan(1000);
    const keys = requests.map((r) => assigned.get(r.id));
    expect(new Set(keys).size).toBe(20_000);
    expect(keys.slice(0, 3)).toEqual(["a", "a-2", "a-3"]);
    expect(warnings).toHaveLength(20_000);
  });

  it("a key that is valid and free keeps its name even when invalid keys that slug to it come first", () => {
    const assigned = assignKeys([{ id: "x", key: "a!", pointer: "/x" }, { id: "y", key: "a", pointer: "/y" }], new Set(), "message", () => undefined);
    expect([assigned.get("x"), assigned.get("y")]).toEqual(["a-2", "a"]);
  });
});

describe("suggestTraitKey", () => {
  it("takes the name, then the title, then `trait`; a text without a letter or digit is not used", () => {
    expect(suggestTraitKey({ name: "Audit log", title: "T" }, new Set())).toBe("Audit-log");
    expect(suggestTraitKey({ title: "Retry policy" }, new Set())).toBe("Retry-policy");
    expect(suggestTraitKey({ name: "!!!", title: "Second" }, new Set())).toBe("Second");
    expect(suggestTraitKey({}, new Set())).toBe("trait");
    expect(suggestTraitKey({ name: 42 }, new Set())).toBe("trait");
  });

  it("is unique within `taken` once the caller adds it, and thousands of them are fast", () => {
    const taken = new Set<string>();
    const started = performance.now();
    const keys = Array.from({ length: 20_000 }, () => {
      const key = suggestTraitKey({}, taken);
      taken.add(key);
      return key;
    });
    expect(performance.now() - started).toBeLessThan(500);
    expect(keys.slice(0, 3)).toEqual(["trait", "trait-2", "trait-3"]);
    expect(new Set(keys).size).toBe(20_000);
  });
});

describe("the whole import with thousands of messages whose keys all slug to one base", () => {
  it("20,000 inline messages: keys a, a-2, a-3, … with no duplicate, in well under a few seconds", () => {
    const messages = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [collidingKey(i), { payload: { type: "object" } }]));
    const raw: RawAsyncApi3 = { asyncapi: "3.0.0", info: { title: "T" }, servers: { s: { host: "h:1", protocol: "kafka" } }, channels: { c: { address: "x", messages } } };
    const started = performance.now();
    const extracted = extractPayloads(raw);
    expect(extracted.success).toBe(true);
    if (!extracted.success) return;
    const payloadPins = new Map(extracted.data.map((p) => [`${p.messageKey}:${p.role}`, { entityId: `e${p.messageKey}`, entityVersionId: null }]));
    const mapped = mapAsyncApiToEventDocument(raw, { payloadPins, builtInTraitIds: {} });
    expect(performance.now() - started).toBeLessThan(4000);
    expect(mapped.success).toBe(true);
    if (!mapped.success) return;
    const keys = mapped.data.document.messages.map((m) => m.key);
    expect(keys).toHaveLength(20_000);
    expect(new Set(keys).size).toBe(20_000);
    expect(keys.slice(0, 4)).toEqual(["a", "a-2", "a-3", "a-4"]);
    expect(keys[19_999]).toBe("a-20000");
    expect(extracted.data.map((p) => p.messageKey)).toEqual(keys); // extractPayloads and the mapper agree
    expect(mapped.data.document.channels[0].messageKeys).toEqual(keys);
    expect(mapped.data.warnings.at(-1)?.message).toMatch(/more warnings were omitted/);
  }, 30_000);
});
