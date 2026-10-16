import { describe, expect, it } from "vitest";
import {
  locateProblem, problemMessage, problemsByField, readProblems, uniqueProblems,
} from "@/features/events/builder/problems";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";

const pin = { entityId: "e1", entityVersionId: "v1" };

function doc(): EventDocument {
  return {
    ...emptyEventDocument("Orders"),
    traits: [
      { key: "idempotent", kind: "MESSAGE", spec: { name: "Idempotent" } },
      { key: "audited", kind: "OPERATION", libraryTraitId: "lib-1" },
    ],
    components: { securitySchemes: { "api-key": { type: "httpApiKey", name: "X-Key", in: "header" }, "a/b": { type: "plain" } } },
    servers: [
      { key: "kafka-prod", protocol: "kafka", host: "h:9092" },
      { key: "kafka-dev", protocol: "kafka", host: "d:9092" },
    ],
    channels: [
      { key: "orders", address: "orders", protocol: "kafka", serverKeys: [], format: "avro", messageKeys: ["OrderCreated"] },
      { key: "refunds", address: "refunds", protocol: "kafka", serverKeys: [], format: "avro", messageKeys: [] },
    ],
    messages: [{ key: "OrderCreated", payload: pin, traitKeys: [] }],
    operations: [{ key: "publishOrder", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
  };
}

describe("locateProblem", () => {
  it("maps /servers/<i>/… onto the servers section and the server's key", () => {
    expect(locateProblem(doc(), "/servers/1/host")).toEqual({ section: "servers", item: "kafka-dev" });
    expect(locateProblem(doc(), "/servers/0")).toEqual({ section: "servers", item: "kafka-prod" });
  });

  it("maps channels, messages and operations onto their sections and keys", () => {
    expect(locateProblem(doc(), "/channels/1/address")).toEqual({ section: "channels", item: "refunds" });
    expect(locateProblem(doc(), "/channels/0/serverKeys/2")).toEqual({ section: "channels", item: "orders" });
    expect(locateProblem(doc(), "/messages/0/payload/entityId")).toEqual({ section: "messages", item: "OrderCreated" });
    expect(locateProblem(doc(), "/operations/0/messageKeys/0")).toEqual({ section: "operations", item: "publishOrder" });
    expect(locateProblem(doc(), "/operations/0/reply/channelKey")).toEqual({ section: "operations", item: "publishOrder" });
  });

  it("maps /info/… and /defaultContentType onto the metadata section without an item", () => {
    expect(locateProblem(doc(), "/info/title")).toEqual({ section: "metadata", item: null });
    expect(locateProblem(doc(), "/info")).toEqual({ section: "metadata", item: null });
    expect(locateProblem(doc(), "/defaultContentType")).toEqual({ section: "metadata", item: null });
  });

  it("returns the section only when the pointer names the list itself, a missing index or a non-index", () => {
    expect(locateProblem(doc(), "/servers")).toEqual({ section: "servers", item: null });
    expect(locateProblem(doc(), "/channels/9/address")).toEqual({ section: "channels", item: null });
    expect(locateProblem(doc(), "/messages/first/key")).toEqual({ section: "messages", item: null });
    expect(locateProblem(doc(), "/operations/-1/key")).toEqual({ section: "operations", item: null });
  });

  it("does not resolve an index that only looks numeric (leading zero, exponent) or an inherited property", () => {
    expect(locateProblem(doc(), "/servers/01/host")).toEqual({ section: "servers", item: null });
    expect(locateProblem(doc(), "/servers/1e0/host")).toEqual({ section: "servers", item: null });
    expect(locateProblem(doc(), "/servers/length/host")).toEqual({ section: "servers", item: null });
  });

  it("gives an item whose key is blank no item", () => {
    const d = doc();
    d.servers[0] = { ...d.servers[0], key: "" };
    expect(locateProblem(d, "/servers/0/key")).toEqual({ section: "servers", item: null });
  });

  it("maps /traits/<i>/… onto the traits section and the trait's key", () => {
    expect(locateProblem(doc(), "/traits/0/spec/name")).toEqual({ section: "traits", item: "idempotent" });
    expect(locateProblem(doc(), "/traits/1/libraryTraitId")).toEqual({ section: "traits", item: "audited" });
    expect(locateProblem(doc(), "/traits/0/kind")).toEqual({ section: "traits", item: "idempotent" });
    expect(locateProblem(doc(), "/traits/0")).toEqual({ section: "traits", item: "idempotent" });
  });

  it("returns the traits section only for the list itself, a missing index or a non-index", () => {
    expect(locateProblem(doc(), "/traits")).toEqual({ section: "traits", item: null });
    expect(locateProblem(doc(), "/traits/9/spec")).toEqual({ section: "traits", item: null });
    expect(locateProblem(doc(), "/traits/first/spec")).toEqual({ section: "traits", item: null });
    expect(locateProblem(doc(), "/traits/01/spec")).toEqual({ section: "traits", item: null });
  });

  it("maps /components/securitySchemes/<name>/… onto the advanced section and the scheme's name", () => {
    expect(locateProblem(doc(), "/components/securitySchemes/api-key/name")).toEqual({ section: "advanced", item: "api-key" });
    expect(locateProblem(doc(), "/components/securitySchemes/api-key")).toEqual({ section: "advanced", item: "api-key" });
    expect(locateProblem(doc(), "/components/securitySchemes/api-key/flows/implicit/tokenUrl")).toEqual({ section: "advanced", item: "api-key" });
  });

  it("decodes RFC 6901 escapes in the scheme name", () => {
    expect(locateProblem(doc(), "/components/securitySchemes/a~1b")).toEqual({ section: "advanced", item: "a/b" });
  });

  it("maps /components itself, the schemes map and a scheme the document does not have onto advanced without an item", () => {
    expect(locateProblem(doc(), "/components")).toEqual({ section: "advanced", item: null });
    expect(locateProblem(doc(), "/components/securitySchemes")).toEqual({ section: "advanced", item: null });
    expect(locateProblem(doc(), "/components/securitySchemes/gone/type")).toEqual({ section: "advanced", item: null });
    expect(locateProblem(doc(), "/components/parameters/x")).toEqual({ section: "advanced", item: null });
    expect(locateProblem(doc(), "/components/correlationIds")).toEqual({ section: "advanced", item: null });
  });

  it("does not take an inherited property for a scheme", () => {
    expect(locateProblem(doc(), "/components/securitySchemes/constructor/type")).toEqual({ section: "advanced", item: null });
    expect(locateProblem(doc(), "/components/securitySchemes/__proto__")).toEqual({ section: "advanced", item: null });
  });

  it("returns { section: null, item: null } for pointers no section owns", () => {
    for (const pointer of ["", "/documentVersion", "/externalRefs/0/key", "servers/0", "/nope", "/componentsX", "/trait/0"]) {
      expect(locateProblem(doc(), pointer)).toEqual({ section: null, item: null });
    }
  });

  it("is not confused by RFC 6901 escapes in deeper segments", () => {
    expect(locateProblem(doc(), "/channels/0/parameters/a~1b")).toEqual({ section: "channels", item: "orders" });
  });
});

describe("problemsByField", () => {
  const problems = [
    { pointer: "/info/title", message: "title is required" },
    { pointer: "/info/titles", message: "sibling" },
    { pointer: "/info", message: "info must be an object" },
    { pointer: "/servers/1/host", message: "host is required" },
    { pointer: "/servers/10/host", message: "other server" },
    { pointer: "/channels/0/messageKeys/0", message: "Unknown message" },
    { pointer: "/channels/0/messageKeys/1", message: "Unknown message too" },
  ];

  it("matches the exact pointer", () => {
    expect(problemsByField(problems, "/info/title")).toEqual([{ pointer: "/info/title", message: "title is required" }]);
  });

  it("does not match a sibling that only shares a string prefix", () => {
    expect(problemsByField(problems, "/info/title").map((p) => p.pointer)).not.toContain("/info/titles");
    expect(problemsByField(problems, "/servers/1").map((p) => p.pointer)).toEqual(["/servers/1/host"]);
  });

  it("matches the prefix itself and everything nested under it, in the original order", () => {
    expect(problemsByField(problems, "/channels/0/messageKeys").map((p) => p.message)).toEqual(["Unknown message", "Unknown message too"]);
    expect(problemsByField(problems, "/info").map((p) => p.pointer)).toEqual(["/info/title", "/info/titles", "/info"]);
  });

  it("returns nothing for a prefix no problem sits under", () => {
    expect(problemsByField(problems, "/operations")).toEqual([]);
    expect(problemsByField([], "/info")).toEqual([]);
  });

  it("collapses identical pointer + message pairs, so concatenating client and server problems never shows an error twice", () => {
    const both = [
      { pointer: "/info/title", message: "title is required" },
      { pointer: "/info/title", message: "title is required" },
      { pointer: "/info/title", message: "another" },
    ];
    expect(problemsByField(both, "/info/title")).toEqual([
      { pointer: "/info/title", message: "title is required" }, { pointer: "/info/title", message: "another" },
    ]);
  });

  it("an empty prefix matches every problem (the document itself)", () => {
    expect(problemsByField([{ pointer: "", message: "Document must be an object" }, { pointer: "/info/title", message: "x" }], "")).toHaveLength(2);
  });
});

describe("uniqueProblems / problemMessage / readProblems", () => {
  it("uniqueProblems keeps the first of each pointer + message pair", () => {
    const a = { pointer: "/a", message: "m" };
    expect(uniqueProblems([a, { ...a }, { pointer: "/a", message: "n" }, { pointer: "/b", message: "m" }])).toEqual([
      a, { pointer: "/a", message: "n" }, { pointer: "/b", message: "m" },
    ]);
  });

  it("problemMessage joins the distinct messages and is undefined without problems", () => {
    expect(problemMessage([])).toBeUndefined();
    expect(problemMessage([{ pointer: "/a", message: "one" }, { pointer: "/b", message: "one" }, { pointer: "/c", message: "two" }])).toBe("one; two");
  });

  it("readProblems keeps only well-formed { pointer, message } pairs from an action result's details", () => {
    expect(readProblems({ problems: [{ pointer: "/a", message: "m" }, { pointer: 1, message: "bad" }, null, { pointer: "/b" }, "x"] })).toEqual([
      { pointer: "/a", message: "m" },
    ]);
    expect(readProblems(undefined)).toEqual([]);
    expect(readProblems({})).toEqual([]);
    expect(readProblems({ problems: "nope" })).toEqual([]);
    expect(readProblems(null)).toEqual([]);
  });
});
