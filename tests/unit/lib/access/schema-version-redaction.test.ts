// @vitest-environment node
/**
 * KD-046: a stored generated schema (`metadata.schemaVersions[target][n]`) carries the files of EVERY entity of the closure it was generated from,
 * including entities the reader may not read (a version made by a wider role, a tenant administrator). The read boundary redacts what the READER's roles
 * do not cover; this is the pure rule (`redactSchemaVersionsMap`), proven file by file. The surfaces that call it (the Schemas tab action, the v1 route,
 * the entity page, the change log) are tested in their own files.
 */
import { describe, expect, it } from "vitest";
import {
  HIDDEN_FILES_NOTE,
  entityIdsToJudge,
  hiddenFileCount,
  omitSchemaVersions,
  redactSchemaVersionsMap,
  withoutStoredSchemaVersions,
} from "@/lib/access/schema-version-redaction";
import { bundleEmittedFiles } from "@/lib/typespec-official/closure-emit";
import type { SchemaVersion, SchemaVersionsMap } from "@/types/schema-version";

const ROOT = "root";
const SIBLING = "sibling"; // an entity the reader may read (same domain)
const SECRET = "secret"; // an entity of another domain: the reader may not read it

type File = { path: string; content: string; target: string; entityId?: string };
const file = (path: string, content: string, entityId?: string, target = "json-schema"): File => ({ path, content, target, ...(entityId ? { entityId } : {}) });

/** A closure version: the files, the `output` the generator bundled from them, and the resolution listing the members. */
function version(files: File[], members: string[] = [ROOT, SIBLING, SECRET], over: Partial<SchemaVersion> = {}): SchemaVersion {
  return {
    version: 1,
    status: "draft",
    output: bundleEmittedFiles(files),
    generatedAt: "2026-01-01T00:00:00.000Z",
    entityVersion: 1,
    files: files as SchemaVersion["files"],
    resolution: {
      mode: "draft",
      preview: true,
      entities: members.map((id) => ({ ref: { entityId: id, domain: `dom-${id}`, product: `prod-${id}`, entity: `Name-${id}` }, source: "draft" as const })),
      notes: ["Name-secret: pinned by an unpinned edge"],
    },
    ...over,
  };
}

const JSON_FILES = [file("Root.json", '{"title":"Root","properties":{"s":{"$ref":"Secret.json"}}}', ROOT), file("Sibling.json", '{"title":"Sibling"}', SIBLING), file("Secret.json", '{"title":"Secret","properties":{"ssn":{}}}', SECRET)];

const mayReadSet = (...ids: string[]) => (id: string) => id === ROOT || ids.includes(id);
const redact = (versions: SchemaVersionsMap, mayRead: (id: string) => boolean) => redactSchemaVersionsMap(versions, { rootEntityId: ROOT, mayRead });

describe("a reader who may read every entity of the closure", () => {
  it("gets the stored version untouched (same files, same output, same resolution, no mark)", () => {
    const stored = { "json-schema": [version(JSON_FILES)] };
    const out = redact(stored, () => true);
    expect(out).toEqual(stored);
    expect(out["json-schema"][0].redacted).toBeUndefined();
  });
});

describe("a reader who may read only the root", () => {
  const stored = { "json-schema": [version(JSON_FILES)] };
  const out = redact(stored, mayReadSet())["json-schema"][0];

  it("sees the root's own file and no other", () => {
    expect(out.files?.map((f) => f.path)).toEqual(["Root.json"]);
    expect(out.files?.map((f) => f.entityId)).toEqual([ROOT]);
  });

  it("gets `output` rebuilt from the permitted files (the bare content of the one file), never a cut of the stored bundle", () => {
    expect(out.output).toBe(JSON_FILES[0].content);
    expect(out.output).not.toContain("Sibling");
    expect(out.output).not.toContain("ssn");
    expect(out.output).toBe(bundleEmittedFiles(out.files ?? []));
  });

  it("is told how many files are hidden, and the names of the entities behind them are gone from the resolution and its notes", () => {
    expect(out.redacted).toEqual({ hiddenFiles: 2, hiddenEntities: 2 });
    expect(out.resolution?.entities.map((e) => e.ref.entityId)).toEqual([ROOT]);
    expect(out.resolution?.notes).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("Name-secret");
    expect(JSON.stringify(out)).not.toContain("Name-sibling");
    expect(JSON.stringify(out)).not.toContain("dom-secret");
  });

  it("keeps everything that is not about other entities (version number, status, dates, preview flag)", () => {
    expect(out).toMatchObject({ version: 1, status: "draft", generatedAt: "2026-01-01T00:00:00.000Z", entityVersion: 1 });
    expect(out.resolution).toMatchObject({ mode: "draft", preview: true });
  });

  it("does not change what was stored (a pure function of its input)", () => {
    const frozen = JSON.parse(JSON.stringify(stored));
    redact(stored, mayReadSet());
    expect(stored).toEqual(frozen);
  });
});

describe("a reader of the root and some of the closure", () => {
  it("keeps the files of the entities they may read and rebuilds the bundle in the stored order with the stored format", () => {
    const out = redact({ "json-schema": [version(JSON_FILES)] }, mayReadSet(SIBLING))["json-schema"][0];
    expect(out.files?.map((f) => f.path)).toEqual(["Root.json", "Sibling.json"]);
    expect(out.output).toBe(bundleEmittedFiles([JSON_FILES[0], JSON_FILES[1]]));
    expect(out.output.startsWith("===== Root.json =====")).toBe(true);
    // the root's own file still names what the root refers to (the author wrote that field); nothing of the other entity's DEFINITION is left
    expect(out.output).not.toContain('"title":"Secret"');
    expect(out.output).not.toContain("ssn");
    expect(out.redacted).toEqual({ hiddenFiles: 1, hiddenEntities: 1 });
    expect(out.resolution?.entities.map((e) => e.ref.entityId)).toEqual([ROOT, SIBLING]);
  });

  it("a file without an entityId is the root's own and always passes", () => {
    const files = [file("Root.json", "{}"), file("Secret.json", '{"s":1}', SECRET)];
    const out = redact({ "json-schema": [version(files, [ROOT, SECRET])] }, mayReadSet())["json-schema"][0];
    expect(out.files?.map((f) => f.path)).toEqual(["Root.json"]);
  });
});

describe("every version of every target is judged on its own", () => {
  it("redacts the older versions too (the history is readable, not only the latest)", () => {
    const stored: SchemaVersionsMap = {
      "json-schema": [version(JSON_FILES, undefined, { version: 3 }), version([JSON_FILES[0]], [ROOT], { version: 2 }), version(JSON_FILES, undefined, { version: 1 })],
    };
    const out = redact(stored, mayReadSet())["json-schema"];
    expect(out.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(out.map((v) => v.files?.length)).toEqual([1, 1, 1]);
    expect(out.map((v) => v.redacted?.hiddenFiles)).toEqual([2, undefined, 2]);
    expect(out[1]).toEqual(stored["json-schema"][1]);
  });

  it("a version with no files (a database target, a version stored before multi-entity emission) is the entity's own and stays as it is", () => {
    const own: SchemaVersion = { version: 1, status: "published", output: "CREATE TABLE t (id INT);", generatedAt: "x", entityVersion: 1 };
    expect(redact({ bigquery: [own] }, mayReadSet())).toEqual({ bigquery: [own] });
  });
});

describe("files that carry more than the entity they are tagged with", () => {
  it("OpenAPI and Avro files are self-contained (the root's file inlines what it refers to): with an unreadable member in the closure NO file of the version is shown", () => {
    for (const target of ["openapi3", "avro"]) {
      const files = [
        file("openapi.Root.yaml", "components:\n  schemas:\n    Root: {}\n    Secret:\n      ssn: {}", ROOT, target),
        file("openapi.Secret.yaml", "Secret: {}", SECRET, target),
      ];
      const out = redact({ [target]: [version(files, [ROOT, SECRET])] }, mayReadSet())[target][0];
      expect(out.files).toEqual([]);
      expect(out.output).toBe("");
      expect(out.redacted).toEqual({ hiddenFiles: 2, hiddenEntities: 1 });
      expect(JSON.stringify(out)).not.toContain("ssn");
    }
  });

  it("OpenAPI and Avro versions whose closure the reader may read in full are shown whole", () => {
    const files = [file("openapi.Root.yaml", "Root: {}", ROOT, "openapi3"), file("openapi.Sibling.yaml", "Sibling: {}", SIBLING, "openapi3")];
    const stored = { openapi3: [version(files, [ROOT, SIBLING])] };
    expect(redact(stored, mayReadSet(SIBLING))).toEqual(stored);
  });

  it("a member with no file of its own is served by a SHARED file (a Protobuf cycle): when that member is unreadable, no file of the version is shown", () => {
    // root and secret form a cycle: one .proto tagged with the FIRST member (root), no file tagged secret.
    const files = [file("root.proto", "message Root {}\nmessage Secret { string ssn = 1; }", ROOT, "protobuf")];
    const out = redact({ protobuf: [version(files, [ROOT, SECRET])] }, mayReadSet())["protobuf"][0];
    expect(out.files).toEqual([]);
    expect(out.output).toBe("");
    expect(JSON.stringify(out)).not.toContain("ssn");
  });

  it("the same shared file is fine for a reader who may read every member of the cycle", () => {
    const files = [file("root.proto", "message Root {}\nmessage Secret {}", ROOT, "protobuf")];
    const stored = { protobuf: [version(files, [ROOT, SECRET])] };
    expect(redact(stored, mayReadSet(SECRET))).toEqual(stored);
  });
});

describe("malformed stored data is never passed through", () => {
  it("keeps only what it can judge: a non-object map is empty, a non-array target is empty, a version that is not an object is dropped", () => {
    expect(redactSchemaVersionsMap(null as never, { rootEntityId: ROOT, mayRead: () => false })).toEqual({});
    expect(redactSchemaVersionsMap("x" as never, { rootEntityId: ROOT, mayRead: () => false })).toEqual({});
    expect(redact({ a: "text" as never, b: [null as never, 4 as never] }, () => false)).toEqual({ a: [], b: [] });
  });

  it("a file list with a broken entry drops the entry (an entry with no string content cannot be judged)", () => {
    const broken = version([JSON_FILES[0]], [ROOT]);
    (broken.files as unknown[]).push(null, { path: 1, content: 2 }, "x");
    const out = redact({ "json-schema": [broken] }, mayReadSet())["json-schema"][0];
    expect(out.files?.map((f) => f.path)).toEqual(["Root.json"]);
  });
});

describe("what has to be judged", () => {
  it("lists every entity id named by a file or by the resolution, once, without the root", () => {
    const stored = { "json-schema": [version(JSON_FILES), version([JSON_FILES[0], JSON_FILES[1]], [ROOT, SIBLING, "other"])] };
    expect(entityIdsToJudge(stored, ROOT).sort()).toEqual(["other", SECRET, SIBLING].sort());
  });

  it("is empty for a map with nothing but the root (nothing to look up)", () => {
    expect(entityIdsToJudge({ "json-schema": [version([JSON_FILES[0]], [ROOT])] }, ROOT)).toEqual([]);
    expect(entityIdsToJudge(undefined, ROOT)).toEqual([]);
  });

  it("counts the files hidden across a map and has the note in the words the screen shows", () => {
    const out = redact({ "json-schema": [version(JSON_FILES)], protobuf: [version(JSON_FILES)] }, mayReadSet());
    expect(hiddenFileCount(out)).toBe(4);
    expect(HIDDEN_FILES_NOTE(2)).toBe("2 files of referenced entities are hidden for your role");
    expect(HIDDEN_FILES_NOTE(1)).toBe("1 file of referenced entities is hidden for your role");
  });
});

describe("the stored versions are not part of other views of the entity", () => {
  it("omitSchemaVersions drops the key and nothing else, on a copy", () => {
    const meta = { tags: ["a"], schemaVersions: { x: [] } };
    const out = omitSchemaVersions(meta);
    expect(out).toEqual({ tags: ["a"] });
    expect(meta.schemaVersions).toBeDefined();
    expect(omitSchemaVersions(null)).toBeNull();
    expect(omitSchemaVersions("text")).toBe("text");
    const none = { tags: [] };
    expect(omitSchemaVersions(none)).toBe(none);
  });

  it("withoutStoredSchemaVersions cleans an audit state: the whole entity row, or a `{ metadata }` wrapper", () => {
    expect(withoutStoredSchemaVersions({ id: "e", metadata: { tags: [], schemaVersions: { x: [{}] } } })).toEqual({ id: "e", metadata: { tags: [] } });
    expect(withoutStoredSchemaVersions({ metadata: { schemaVersions: {} } })).toEqual({ metadata: {} });
    expect(withoutStoredSchemaVersions({ schemaVersions: {}, a: 1 })).toEqual({ a: 1 });
    expect(withoutStoredSchemaVersions(null)).toBeNull();
    expect(withoutStoredSchemaVersions({ status: "ACTIVE" })).toEqual({ status: "ACTIVE" });
  });
});
