import { describe, expect, it } from "vitest";
import {
  addSecurityScheme, newSchemeName, removeSecurityScheme, renameSecurityScheme, schemeNameProblem, schemeReferences, schemesOf,
  updateSecurityScheme,
} from "@/features/events/builder/security-schemes";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";

const pin = { entityId: "e1", entityVersionId: "v1" };

/** Two schemes; `api-key` is used by a server, an operation and an operation trait, `basic` by a second server only. */
function doc(): EventDocument {
  return {
    ...emptyEventDocument("Orders"),
    servers: [
      { key: "prod", protocol: "kafka", host: "h:9092", security: ["api-key", "basic"] },
      { key: "dev", protocol: "kafka", host: "d:9092", security: ["basic"] },
      { key: "bare", protocol: "kafka", host: "b:9092" },
    ],
    channels: [{ key: "orders", address: "orders", protocol: "kafka", serverKeys: [], messageKeys: ["Created"] }],
    messages: [{ key: "Created", payload: pin, traitKeys: [] }],
    traits: [
      { key: "secured", kind: "OPERATION", spec: { title: "Secured", security: ["api-key"] } },
      { key: "plain-op", kind: "OPERATION", spec: { title: "Plain" } },
      { key: "lib", kind: "OPERATION", libraryTraitId: "lib-1" },
      { key: "msg", kind: "MESSAGE", spec: { name: "Msg" } },
    ],
    operations: [{ key: "publish", action: "send", channelKey: "orders", messageKeys: ["Created"], traitKeys: ["secured"], security: ["api-key"] }],
    components: {
      securitySchemes: { "api-key": { type: "httpApiKey", name: "X-Key", in: "header" }, basic: { type: "http", scheme: "basic" } },
      parameters: { id: {} },
    },
  };
}

it("the fixture is a valid document, so any problem below comes from the edit under test", () => {
  expect(parseEventDocument(doc()).success).toBe(true);
});

describe("schemesOf", () => {
  it("is the security schemes map, or an empty one when the document has none", () => {
    expect(Object.keys(schemesOf(doc()))).toEqual(["api-key", "basic"]);
    expect(schemesOf(emptyEventDocument("Orders"))).toEqual({});
    expect(schemesOf({ ...emptyEventDocument("Orders"), components: { parameters: {} } })).toEqual({});
  });
});

describe("schemeReferences", () => {
  it("lists the servers, operations and local traits that name the scheme, by key", () => {
    expect(schemeReferences(doc(), "api-key")).toEqual({ servers: ["prod"], operations: ["publish"], traits: ["secured"] });
    expect(schemeReferences(doc(), "basic")).toEqual({ servers: ["prod", "dev"], operations: [], traits: [] });
  });

  it("is empty for a scheme nothing uses or that does not exist", () => {
    expect(schemeReferences(doc(), "nobody")).toEqual({ servers: [], operations: [], traits: [] });
  });

  it("ignores a library trait (it has no spec) and a malformed security value", () => {
    const d = doc();
    d.traits.push({ key: "odd", kind: "OPERATION", spec: { security: "api-key" } });
    expect(schemeReferences(d, "api-key").traits).toEqual(["secured"]);
  });
});

describe("schemeNameProblem", () => {
  it("accepts a fresh valid name and a scheme's own current name", () => {
    expect(schemeNameProblem(doc(), "oauth", null)).toBeNull();
    expect(schemeNameProblem(doc(), "api-key", "api-key")).toBeNull();
    expect(schemeNameProblem(doc(), "Api_Key.2", null)).toBeNull();
  });

  it("requires a name", () => {
    expect(schemeNameProblem(doc(), "", null)).toBe("A name is required.");
  });

  it("refuses a name another scheme already has, with a message that names it", () => {
    expect(schemeNameProblem(doc(), "basic", "api-key")).toBe('A security scheme named "basic" already exists.');
    expect(schemeNameProblem(doc(), "basic", null)).toBe('A security scheme named "basic" already exists.');
  });

  it("refuses spaces and punctuation the components key rule does not allow", () => {
    expect(schemeNameProblem(doc(), "my scheme", null)).toBe('Use only letters, digits, ".", "_" and "-" (no spaces).');
    expect(schemeNameProblem(doc(), "a/b", null)).toBe('Use only letters, digits, ".", "_" and "-" (no spaces).');
  });

  it("refuses a name longer than 64 characters", () => {
    expect(schemeNameProblem(doc(), "a".repeat(64), null)).toBeNull();
    expect(schemeNameProblem(doc(), "a".repeat(65), null)).toBe("A name can be at most 64 characters.");
  });

  it("refuses the names that collide with Object.prototype", () => {
    // `constructor` and `prototype` are only JS-prototype names (the plain wording); `__proto__` is also on the parser's list (its wording)
    for (const name of ["constructor", "prototype"]) expect(schemeNameProblem(doc(), name, null)).toBe(`"${name}" is reserved. Choose another name.`);
    expect(schemeNameProblem(doc(), "__proto__", null)).toBe('"__proto__" is a reserved name: AsyncAPI documents cannot contain it. Choose another name.');
  });

  it("refuses hasOwnProperty, the name the AsyncAPI parser cannot read, and only that exact name", () => {
    expect(schemeNameProblem(doc(), "hasOwnProperty", null)).toBe('"hasOwnProperty" is a reserved name: AsyncAPI documents cannot contain it. Choose another name.');
    for (const name of ["hasownproperty", "HasOwnProperty", "hasOwnProperty2"]) expect(schemeNameProblem(doc(), name, null), name).toBeNull();
  });
});

describe("newSchemeName", () => {
  it("starts from `scheme` and counts up while taken", () => {
    expect(newSchemeName(emptyEventDocument("Orders"))).toBe("scheme");
    const d = doc();
    d.components = { securitySchemes: { scheme: { type: "plain" } } };
    expect(newSchemeName(d)).toBe("scheme-2");
    d.components = { securitySchemes: { scheme: { type: "plain" }, "scheme-2": { type: "plain" } } };
    expect(newSchemeName(d)).toBe("scheme-3");
  });
});

describe("addSecurityScheme / updateSecurityScheme", () => {
  it("creates components and securitySchemes on a document that has none", () => {
    const next = addSecurityScheme(emptyEventDocument("Orders"), "scheme", { type: "userPassword" });
    expect(next.components).toEqual({ securitySchemes: { scheme: { type: "userPassword" } } });
  });

  it("appends to the existing schemes and keeps the other components", () => {
    const next = addSecurityScheme(doc(), "oauth", { type: "oauth2", flows: {} });
    expect(Object.keys(next.components?.securitySchemes ?? {})).toEqual(["api-key", "basic", "oauth"]);
    expect(next.components?.parameters).toEqual({ id: {} });
  });

  it("does not mutate its input", () => {
    const before = doc();
    const snapshot = structuredClone(before);
    addSecurityScheme(before, "oauth", { type: "plain" });
    updateSecurityScheme(before, "basic", { type: "plain" });
    expect(before).toEqual(snapshot);
  });

  it("update replaces one scheme in place, keeping the order", () => {
    const next = updateSecurityScheme(doc(), "api-key", { type: "plain" });
    expect(Object.entries(next.components?.securitySchemes ?? {})).toEqual([
      ["api-key", { type: "plain" }], ["basic", { type: "http", scheme: "basic" }],
    ]);
  });

  it("update of an unknown scheme returns the same document", () => {
    const d = doc();
    expect(updateSecurityScheme(d, "gone", { type: "plain" })).toBe(d);
  });
});

describe("renameSecurityScheme", () => {
  it("renames the scheme in place and rewrites server, operation and trait references", () => {
    const result = renameSecurityScheme(doc(), "api-key", "key-v2");
    expect(result.success).toBe(true);
    if (!result.success) return;
    const next = result.data;
    expect(Object.keys(next.components?.securitySchemes ?? {})).toEqual(["key-v2", "basic"]);
    expect(next.components?.securitySchemes?.["key-v2"]).toEqual({ type: "httpApiKey", name: "X-Key", in: "header" });
    expect(next.servers.map((s) => s.security)).toEqual([["key-v2", "basic"], ["basic"], undefined]);
    expect(next.operations[0].security).toEqual(["key-v2"]);
    expect((next.traits[0] as { spec: { security?: string[] } }).spec.security).toEqual(["key-v2"]);
    expect(parseEventDocument(next).success).toBe(true);
  });

  it("keeps the other components and leaves untouched items as they were", () => {
    const before = doc();
    const result = renameSecurityScheme(before, "api-key", "key-v2");
    if (!result.success) throw new Error("rename failed");
    expect(result.data.components?.parameters).toEqual({ id: {} });
    expect(result.data.servers[2]).toBe(before.servers[2]);
    expect(result.data.traits[1]).toBe(before.traits[1]);
  });

  it("does not mutate its input", () => {
    const before = doc();
    const snapshot = structuredClone(before);
    renameSecurityScheme(before, "api-key", "key-v2");
    expect(before).toEqual(snapshot);
  });

  it("renaming to the same name changes nothing", () => {
    const d = doc();
    const result = renameSecurityScheme(d, "basic", "basic");
    expect(result).toEqual({ success: true, data: d });
  });

  it("refuses a taken, an invalid, a reserved and an unknown name, leaving the caller's document alone", () => {
    expect(renameSecurityScheme(doc(), "api-key", "basic")).toEqual({ success: false, message: 'A security scheme named "basic" already exists.' });
    expect(renameSecurityScheme(doc(), "api-key", "has space").success).toBe(false);
    expect(renameSecurityScheme(doc(), "api-key", "").success).toBe(false);
    expect(renameSecurityScheme(doc(), "api-key", "constructor").success).toBe(false);
    expect(renameSecurityScheme(doc(), "gone", "other")).toEqual({ success: false, message: 'There is no security scheme named "gone".' });
  });
});

describe("removeSecurityScheme", () => {
  it("removes the scheme and every reference to it, dropping a security list that becomes empty", () => {
    const next = removeSecurityScheme(doc(), "api-key");
    expect(Object.keys(next.components?.securitySchemes ?? {})).toEqual(["basic"]);
    expect(next.servers.map((s) => s.security)).toEqual([["basic"], ["basic"], undefined]);
    expect("security" in next.operations[0]).toBe(false);
    expect("security" in (next.traits[0] as { spec: object }).spec).toBe(false);
    expect((next.traits[0] as { spec: { title?: string } }).spec.title).toBe("Secured");
    expect(parseEventDocument(next).success).toBe(true);
  });

  it("drops securitySchemes, and components with it, when the last scheme goes", () => {
    let next = removeSecurityScheme(doc(), "api-key");
    next = removeSecurityScheme(next, "basic");
    expect(next.components).toEqual({ parameters: { id: {} } });
    const lone = removeSecurityScheme(addSecurityScheme(emptyEventDocument("Orders"), "scheme", { type: "plain" }), "scheme");
    expect("components" in lone).toBe(false);
    expect(parseEventDocument(lone).success).toBe(true);
  });

  it("removes only the named scheme from a list that has others", () => {
    const next = removeSecurityScheme(doc(), "basic");
    expect(next.servers.map((s) => s.security)).toEqual([["api-key"], undefined, undefined]);
  });

  it("an unknown scheme returns the same document", () => {
    const d = doc();
    expect(removeSecurityScheme(d, "gone")).toBe(d);
  });

  it("does not mutate its input", () => {
    const before = doc();
    const snapshot = structuredClone(before);
    removeSecurityScheme(before, "api-key");
    expect(before).toEqual(snapshot);
  });
});
