import { describe, it, expect } from "vitest";
import { digest, freezeArtifact, hierarchyFiles, payloadHash, validateFiles } from "@/lib/deployments/artifact";
import type { SchemaVersion } from "@/types/schema-version";

const entity = { id: "entity-1", name: "Account", tenant: "paypal", domain: "identity", product: "accounts", schema: "account" };
const version = (extra: Partial<SchemaVersion> = {}): SchemaVersion => ({ version: 4, status: "published", output: '{"type":"record","name":"Account","fields":[]}', generatedAt: "2026-11-07", entityVersion: 2, ...extra });

describe("immutable deployment artifacts", () => {
  it("uses the selected artifact with a fixed tenant/domain/product/schema/version hierarchy", () => {
    const bundle = freezeArtifact(entity, "avro", version());
    const files = hierarchyFiles(bundle, "1.0.0_snapshot");
    expect(files[0].path).toBe("schemas/paypal/identity/accounts/account/1.0.0_snapshot/avro/account.schema.avsc");
    expect(files[0].content).toBe(version().output);
    expect(JSON.parse(files[1].content)).toMatchObject({ artifactVersion: 4, sourceEntityVersion: 2, contentHash: bundle.contentHash });
  });
  it("keeps independent artifact formats in separate directories at the same contract version", () => {
    const avro = hierarchyFiles(freezeArtifact(entity, "avro", version()), "1.0.0_snapshot");
    const json = hierarchyFiles(freezeArtifact(entity, "json-schema", version({ output: "{}" })), "1.0.0_snapshot");
    expect(new Set([...avro, ...json].map((f) => f.path)).size).toBe(avro.length + json.length);
  });
  it("hashes identically after JSONB key reordering", () => {
    expect(digest({ z: 2, a: [{ b: 1, a: 0 }] })).toBe(digest({ a: [{ a: 0, b: 1 }], z: 2 }));
    expect(digest({ files: ["a", "b"] })).not.toBe(digest({ files: ["b", "a"] }));
  });
  it("keeps the complete closure and uses an explicit root for shared-cycle files", () => {
    const bundle = freezeArtifact(entity, "protobuf", version({ files: [
      { path: "shared.proto", content: 'syntax = "proto3";', entityId: "entity-2", target: "protobuf" },
      { path: "other.proto", content: 'syntax = "proto3";', entityId: "entity-3", target: "protobuf" },
    ], primaryFile: "shared.proto" }));
    expect(bundle.primaryFile).toBe("shared.proto"); expect(bundle.files).toHaveLength(2);
    expect(bundle.referenceEntityIds).toEqual(["entity-2", "entity-3"]);
  });
  it.each(["../secret", "/absolute", "C:/secret", "one\\two", "one//two", "one/.git/config", "one/./two", "one/file."])("rejects unsafe path %s", (path) => {
    expect(() => validateFiles([{ path, content: "x" }])).toThrow(/unsafe/);
  });
  it.each([["A.json", "a.json"], ["a", "a/b.json"]])("rejects path collisions", (first, second) => {
    expect(() => validateFiles([first, second].map((path) => ({ path, content: "x" })))).toThrow(/collide/);
  });
  it("rejects drafts, partial bundles and legacy concatenations", () => {
    expect(() => freezeArtifact(entity, "avro", version({ status: "draft" }))).toThrow(/Publish/);
    expect(() => freezeArtifact(entity, "avro", version({ redacted: { hiddenFiles: 1, hiddenEntities: 1 } }))).toThrow(/every referenced/);
    expect(() => freezeArtifact(entity, "avro", version({ output: "===== a.avsc =====\n{}" }))).toThrow(/manifest is missing/);
  });
  it("keeps legacy deployment markers usable as published artifacts without creating live state", () => {
    const bundle = freezeArtifact(entity, "avro", version({ status: "deployed" }));
    expect(bundle.version).toBe(4); expect(bundle).not.toHaveProperty("deployed");
  });
  it("does not mutate saved files and detects payload changes", () => {
    const saved = version({ files: [{ path: "Account.avsc", content: "abc", target: "avro", entityId: entity.id }] });
    const a = freezeArtifact(entity, "avro", saved);
    a.files[0].content = "different";
    expect(saved.files![0].content).toBe("abc");
    expect(payloadHash("abc")).not.toBe(payloadHash("abcd"));
  });
});
