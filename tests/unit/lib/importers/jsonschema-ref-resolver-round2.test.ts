import { describe, expect, it } from "vitest";
import { resolveJsonSchemaRefs, type ResolverDeps } from "@/lib/importers/jsonschema-ref-resolver";

const PUBLIC = async () => ["93.184.216.34"];
const json = (o: unknown) => JSON.stringify(o);
const ROOT = "https://example.com/schemas/root.json";
const OK = "https://example.com/schemas/ok.json";
const OK2 = "https://example.com/schemas/ok2.json";

function mk(files: Record<string, string>) {
  const http: string[] = [];
  const deps: ResolverDeps = {
    lookup: PUBLIC,
    fetchHttp: async (u) => {
      http.push(u);
      if (u in files) return files[u]!;
      throw new Error("HTTP 404");
    },
    fetchGitFile: async () => {
      throw new Error("no git");
    },
  };
  return { deps, http };
}
const both = { [OK]: json({ type: "string" }), [OK2]: json({ type: "integer" }) };
const GUARD = /never asked the resolver/;

describe("Gap A: $id / id in the document never affect resolution", () => {
  it.each([
    ["malformed $id", '{"$id":"https://[bad","a":{"$ref":"./ok.json"},"c":{"$ref":"./ok2.json"}}'],
    ["urn $id", '{"$id":"urn:x:y","a":{"$ref":"./ok.json"},"c":{"$ref":"./ok2.json"}}'],
    ["draft-04 id", '{"id":"https://[bad","a":{"$ref":"./ok.json"},"c":{"$ref":"./ok2.json"}}'],
  ])("root with %s still resolves its refs", async (_n, root) => {
    const { deps } = mk(both);
    const r = await resolveJsonSchemaRefs(ROOT, root, deps);
    expect([...r.resolved.keys()].sort()).toEqual([OK, OK2, ROOT].sort());
    expect([...r.unreachable.values()].join("|")).not.toMatch(GUARD);
    expect(r.unreachable.size).toBe(0);
    // originals are untouched
    expect((r.resolved.get(ROOT) as { $id?: string; id?: string }).$id ?? (r.resolved.get(ROOT) as { id?: string }).id).toBeDefined();
  });

  it("a fetched document with a malformed $id still works", async () => {
    const { deps } = mk({
      "https://example.com/schemas/mid.json": json({ $id: "https://[bad", x: { $ref: "ok.json" } }),
      [OK]: json({ type: "string" }),
    });
    const r = await resolveJsonSchemaRefs(ROOT, json({ m: { $ref: "mid.json" } }), deps);
    expect(r.resolved.has(OK)).toBe(true);
    expect(r.unreachable.size).toBe(0);
  });

  it("a property literally named id keeps its refs working", async () => {
    const { deps } = mk(both);
    const root = json({ properties: { id: { $ref: "./ok.json" }, $id: { $ref: "./ok2.json" } } });
    const r = await resolveJsonSchemaRefs(ROOT, root, deps);
    expect(r.resolved.has(OK)).toBe(true);
    expect(r.resolved.has(OK2)).toBe(true);
  });

  it("ignores a hostile $id: refs are fetched against the root URL, never the $id origin", async () => {
    const { deps, http } = mk(both);
    const root = json({ $id: "https://evil.example.net/x/", a: { $ref: "./ok.json" } });
    const r = await resolveJsonSchemaRefs(ROOT, root, deps);
    expect(http).toEqual([OK]);
    expect(http.some((u) => u.includes("evil.example.net"))).toBe(false);
    expect(r.resolved.has(OK)).toBe(true);
  });
});

describe("Gap B: the library-not-called guard has no false positives", () => {
  it.each(["root.json#/definitions/x", "./root.json#/definitions/x", "root.json"])(
    "self-reference by file name (%s) is not an unreachable entry",
    async (ref) => {
      const { deps, http } = mk({});
      const r = await resolveJsonSchemaRefs(
        "https://example.com/d/root.json",
        json({ definitions: { x: { type: "string" } }, a: { $ref: ref } }),
        deps,
      );
      expect(http).toHaveLength(0);
      expect(r.unreachable.size).toBe(0);
      expect(r.resolved.size).toBe(1);
    },
  );

  it("only local #/ refs produce no entries", async () => {
    const { deps } = mk({});
    const r = await resolveJsonSchemaRefs(ROOT, json({ definitions: { x: {} }, a: { $ref: "#/definitions/x" } }), deps);
    expect(r.unreachable.size).toBe(0);
  });

  it("only policy-refused refs yield only those reasons", async () => {
    const { deps } = mk({});
    const r = await resolveJsonSchemaRefs(ROOT, json({ a: { $ref: "ftp://example.com/x" }, b: { $ref: "https://127.0.0.1/x" } }), deps);
    expect(r.unreachable.size).toBe(2);
    expect([...r.unreachable.values()].join("|")).not.toMatch(GUARD);
  });
});
