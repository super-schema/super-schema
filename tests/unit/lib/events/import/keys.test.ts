// tests/unit/lib/events/import/keys.test.ts
// WP-I1 fix round 4: key allocation is linear however many keys slug to the same base (20,000 of them took 40 s, 100,000 fit in 1 MiB).
import { describe, expect, it } from "vitest";
import { uniqueKey } from "@/lib/events/document/keys";
import { suggestKey } from "@/lib/events/templates/keys";
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

/** A small seeded generator (mulberry32): the corpus is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("uniqueIn against the reference `uniqueKey` (which copies the set and searches from -2 every time)", () => {
  /** Bases that share long prefixes, so that candidates cut to 64 characters collide across bases. */
  const BASES = [
    "a", "ab", "message", "k".repeat(64), "k".repeat(63), `${"k".repeat(62)}xy`, `${"k".repeat(62)}xz`, `${"k".repeat(61)}abc`,
    `${"k".repeat(60)}1234`, `${"k".repeat(60)}1235`, "x".repeat(64), `${"x".repeat(59)}-2`, `${"x".repeat(58)}-10`,
  ];

  it("gives the same key on every step of 6,000 random allocations over bases with shared prefixes, across every digit band (-2 … -9999)", () => {
    const random = seeded(20261017);
    const reference = new Set<string>();
    const subject = new Set<string>();
    // some candidates are taken beforehand, with gaps, at the lengths where the stem shortens
    for (const base of BASES) {
      for (const n of [3, 5, 9, 10, 11, 42, 99, 100, 101, 999, 1000]) {
        const suffix = `-${n}`;
        const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
        reference.add(candidate);
        subject.add(candidate);
      }
    }
    for (let step = 0; step < 6000; step += 1) {
      // one base takes most of the steps so that its suffixes pass 1,000
      const base = random() < 0.4 ? BASES[5] : BASES[Math.floor(random() * BASES.length)];
      const expected = uniqueKey(base, reference);
      const actual = uniqueIn(base, subject);
      expect(actual, `step ${step}, base ${base.slice(0, 12)}…`).toBe(expected);
      reference.add(expected);
      subject.add(actual);
    }
    expect(reference.size).toBe(subject.size);
    // The REFERENCE copies the set and searches from -2 on every step: quadratic by design, about 4 s alone and more than vitest's default 5 s
    // when the machine is busy (it failed in a whole-suite run). The timeout is the cost of the reference, not a slack for the code under test.
  }, 60_000);

  it("bases that differ only in their last characters (so they share every candidate) are allocated in turn, in order, without repeating a key", () => {
    const bases = Array.from({ length: 300 }, (_, i) => `${"k".repeat(62)}${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
    const reference = new Set(bases);
    const subject = new Set(bases);
    for (let round = 0; round < 12; round += 1) {
      for (const base of bases) {
        const expected = uniqueKey(base, reference);
        const actual = uniqueIn(base, subject);
        expect(actual).toBe(expected);
        reference.add(expected);
        subject.add(actual);
      }
    }
    expect(subject.size).toBe(300 + 3600);
  });

  it("4,096 shared-prefix bases with 12,000 colliding variants take a fraction of a second (the stem is shared, so is the search)", () => {
    const bases = Array.from({ length: 4096 }, (_, i) => `${"k".repeat(62)}${"abcdefghijklmnopqrstuvwxyz".charAt(i % 26)}${"abcdefghijklmnopqrstuvwxyz".charAt(Math.floor(i / 26) % 26)}`);
    const taken = new Set(bases);
    const started = performance.now();
    const keys = Array.from({ length: 12_000 }, (_, i) => {
      const key = uniqueIn(bases[i % bases.length], taken);
      taken.add(key);
      return key;
    });
    expect(performance.now() - started).toBeLessThan(250); // a few ms with the stem hint; about a second when every base searches the shared stems alone
    expect(new Set(keys).size).toBe(12_000);
  });
});

describe("suggestTraitKey against `suggestKey(\"trait\")`", () => {
  const POOL: unknown[] = [
    undefined, null, "", "   ", "!!!", "Audit log", "Retry/Policy", "日本語", "x".repeat(100), 42, true, "a b", "A-B", "trait", "Trait", "__proto__", "constructor",
    "  padded  ", "ünïcode name", "a".repeat(64), "a".repeat(65), "1", "-", "..", "x-y", ["array"], { object: 1 },
  ];

  it("gives the same key as the reference for 600 generated inputs, sharing one growing set of taken keys", () => {
    const random = seeded(7);
    const reference = new Set<string>();
    const subject = new Set<string>();
    const pick = () => POOL[Math.floor(random() * POOL.length)];
    for (let i = 0; i < 600; i += 1) {
      const values = { name: pick(), title: pick() };
      const expected = suggestKey("trait", values, reference);
      const actual = suggestTraitKey(values, subject);
      expect(actual, `input ${i}: ${JSON.stringify(values)}`).toBe(expected);
      reference.add(expected);
      subject.add(actual);
    }
    expect(subject.size).toBeGreaterThan(30);
  });
});

