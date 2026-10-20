import { describe, expect, it } from "vitest";
import { isParserUnsafeKey, isReservedKey, PARSER_UNSAFE_KEYS, RESERVED_KEYS, setOwn } from "@/lib/event-specs/own-property";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import { channel, message, operation, spec } from "./fixtures/builders";

/** A parser-unsafe name that is not also an `Object.prototype` collision (it is written like any other key), taken from the one list. */
const UNSAFE = [...PARSER_UNSAFE_KEYS].find((key) => !RESERVED_KEYS.has(key)) as string;

describe("own-property: the names that may not be a key", () => {
  it("RESERVED_KEYS is unchanged: the three names that collide with Object.prototype", () => {
    expect([...RESERVED_KEYS].sort()).toEqual(["__proto__", "constructor", "prototype"]);
  });

  it("PARSER_UNSAFE_KEYS is the one list of names the AsyncAPI parser crashes on (the sweep test pins it against the real parser)", () => {
    expect(PARSER_UNSAFE_KEYS.size).toBeGreaterThan(0);
    for (const name of PARSER_UNSAFE_KEYS) expect(Object.getOwnPropertyNames(Object.prototype)).toContain(name);
  });

  it("isParserUnsafeKey is exact and case-sensitive", () => {
    for (const name of PARSER_UNSAFE_KEYS) {
      expect(isParserUnsafeKey(name), name).toBe(true);
      for (const variant of [name.toLowerCase(), name.toUpperCase(), `${name}2`, ` ${name}`, `${name} `, `${name}_1`].filter((v) => v !== name)) {
        expect(isParserUnsafeKey(variant), variant).toBe(false);
      }
    }
    for (const name of ["valueOf", "toString", "constructor", ""]) expect(isParserUnsafeKey(name), name).toBe(false);
  });

  it("isReservedKey is the union: the three collisions and every parser-unsafe key", () => {
    for (const name of [...RESERVED_KEYS, ...PARSER_UNSAFE_KEYS]) expect(isReservedKey(name), name).toBe(true);
    for (const name of ["orders", "toString", "valueOf", UNSAFE.toLowerCase(), `${UNSAFE}2`]) expect(isReservedKey(name), name).toBe(false);
  });

  it("setOwn writes a real own property for every one of them", () => {
    const target = [...PARSER_UNSAFE_KEYS].reduce((object, name) => setOwn(object, name, 1), {});
    expect(Object.keys(target)).toEqual([...PARSER_UNSAFE_KEYS]);
  });
});

describe("the assembler's own RESERVED_KEY check is unchanged", () => {
  const ch = channel({ id: "ch1", name: "orders" });
  const msg = message({ id: "m1", name: "OrderCreated" });
  const assembled = (key: string) => assembleAsyncApi3(spec({ channels: [ch], messages: [msg], operations: [operation({ key, channelRef: ch.id, messageRefs: [msg.id] })] }));
  const reserved = (key: string) => assembled(key).diagnostics.filter((d) => d.code === "RESERVED_KEY");

  it("still reports the three Object.prototype names", () => {
    for (const key of RESERVED_KEYS) expect(reserved(key).map((d) => d.pointer)).toEqual([`/operations/${key}`]);
  });

  it("leaves a parser-unsafe name that is not a collision to the validator's guard (one error, not two), and writes it as an own key", () => {
    expect(reserved(UNSAFE)).toEqual([]);
    expect(Object.keys(assembled(UNSAFE).document.operations as object)).toEqual([UNSAFE]);
  });
});
