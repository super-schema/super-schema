import { describe, expect, it } from "vitest";
import { isParserUnsafeKey, isReservedKey, PARSER_UNSAFE_KEYS, RESERVED_KEYS, setOwn } from "@/lib/event-specs/own-property";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import { channel, message, operation, spec } from "./fixtures/builders";

describe("own-property: the names that may not be a key", () => {
  it("RESERVED_KEYS is unchanged: the three names that collide with Object.prototype", () => {
    expect([...RESERVED_KEYS].sort()).toEqual(["__proto__", "constructor", "prototype"]);
  });

  it("PARSER_UNSAFE_KEYS is the one list of names the AsyncAPI parser crashes on", () => {
    expect([...PARSER_UNSAFE_KEYS].sort()).toEqual(["__proto__", "hasOwnProperty"]);
  });

  it("isParserUnsafeKey is exact and case-sensitive", () => {
    expect(isParserUnsafeKey("hasOwnProperty")).toBe(true);
    for (const name of ["hasownproperty", "HasOwnProperty", "hasOwnProperty2", " hasOwnProperty", "hasOwnProperty ", "valueOf", "toString", "constructor", ""]) {
      expect(isParserUnsafeKey(name), name).toBe(false);
    }
  });

  it("isReservedKey is the union: the three collisions and every parser-unsafe key", () => {
    for (const name of [...RESERVED_KEYS, ...PARSER_UNSAFE_KEYS]) expect(isReservedKey(name), name).toBe(true);
    for (const name of ["hasownproperty", "HasOwnProperty", "orders", "toString", "valueOf"]) expect(isReservedKey(name), name).toBe(false);
  });

  it("setOwn writes a real own property for every one of them", () => {
    const target = setOwn(setOwn({}, "hasOwnProperty", 1), "__proto__", 2);
    expect(Object.keys(target)).toEqual(["hasOwnProperty", "__proto__"]);
  });
});

describe("the assembler's own RESERVED_KEY check is unchanged", () => {
  const ch = channel({ id: "ch1", name: "orders" });
  const msg = message({ id: "m1", name: "OrderCreated" });
  const assembled = (key: string) => assembleAsyncApi3(spec({ channels: [ch], messages: [msg], operations: [operation({ key, channelRef: ch.id, messageRefs: [msg.id] })] }));
  const reserved = (key: string) => assembled(key).diagnostics.filter((d) => d.code === "RESERVED_KEY");

  it("still reports the three Object.prototype names", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) expect(reserved(key).map((d) => d.pointer)).toEqual([`/operations/${key}`]);
  });

  it("leaves hasOwnProperty to the validator's guard (one error, not two), and writes it as an own key", () => {
    expect(reserved("hasOwnProperty")).toEqual([]);
    expect(Object.keys(assembled("hasOwnProperty").document.operations as object)).toEqual(["hasOwnProperty"]);
  });
});
