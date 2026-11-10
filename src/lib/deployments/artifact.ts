import { createHash } from "node:crypto";
import type { SchemaVersion } from "@/types/schema-version";
import type { ArtifactBundle, ArtifactFile } from "./contracts";
import { segment } from "./contracts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
// JSONB changes key order. A plan's identity must survive a database round trip.
export const digest = (value: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
export const payloadHash = (content: string): string => `sha256:${createHash("sha256").update(content).digest("hex")}`;
const EXTENSIONS: Record<string, string> = { avro: ".schema.avsc", "json-schema": ".schema.json", protobuf: ".proto", bigquery: ".sql", postgresql: ".sql", spanner: ".sql", openapi3: ".yaml", "java-pojo": ".java" };

export function safePath(raw: string): string {
  if (!raw || raw.length > 1000 || raw.includes("\\") || /[\x00-\x1f\x7f:]/.test(raw) || raw.startsWith("/") || raw.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git" || /[. ]$/.test(p))) {
    throw new Error("The artifact contains an unsafe file path");
  }
  return raw;
}

export function validateFiles(files: readonly ArtifactFile[]): void {
  if (!files.length || files.length > 500) throw new Error("A delivery requires 1–500 complete artifact files");
  const seen = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    const key = safePath(file.path).toLowerCase();
    if (seen.has(key) || [...seen].some((p) => p.startsWith(`${key}/`) || key.startsWith(`${p}/`))) throw new Error("Artifact file paths collide");
    seen.add(key);
    if (typeof file.content !== "string" || file.content.includes("\0")) throw new Error("Artifact content must be text");
    bytes += Buffer.byteLength(file.content);
  }
  if (bytes > 10 * 1024 * 1024) throw new Error("The artifact exceeds the 10 MB delivery limit");
}

export function freezeArtifact(entity: ArtifactBundle["entity"], format: string, version: SchemaVersion): ArtifactBundle {
  if (version.status !== "published" && version.status !== "deployed") throw new Error("Publish this schema version before deploying it");
  if (version.redacted) throw new Error("Deployment requires access to every referenced artifact");
  if (version.resolution?.entities.some((entry) => entry.ref.entityId !== entity.id && entry.source === "draft")) throw new Error("Publish referenced entities and regenerate before deploying");
  for (const name of ["tenant", "domain", "product", "schema"] as const) segment.parse(entity[name]);
  const files: ArtifactFile[] = version.files?.length
    ? version.files.map((file) => ({ path: file.path, content: file.content, entityId: file.entityId }))
    : [{ path: `${entity.schema}${EXTENSIONS[format] ?? ".txt"}`, content: version.output, entityId: entity.id }];
  if (!version.files?.length && /^===== .+ =====$/m.test(version.output)) throw new Error("Regenerate this legacy bundled artifact before deploying; its file manifest is missing");
  validateFiles(files);
  const primary = (version.primaryFile ? files.find((file) => file.path === version.primaryFile) : undefined) ?? files.find((file) => file.entityId === entity.id) ?? (files.length === 1 ? files[0] : undefined);
  if (!primary) throw new Error("The artifact does not identify its root schema file");
  const ordered = files.toSorted((a, b) => a.path.localeCompare(b.path));
  return { entity, format, version: version.version, sourceEntityVersion: version.entityVersion, generatedAt: version.generatedAt, files: ordered, primaryFile: primary.path, contentHash: digest(ordered.map(({ path, content }) => ({ path, content }))), referenceEntityIds: [...new Set([...(version.resolution?.entities.map((r) => r.ref.entityId) ?? []), ...files.flatMap((f) => f.entityId ? [f.entityId] : [])])].filter((id): id is string => typeof id === "string" && id !== entity.id) };
}

export function hierarchyFiles(bundle: ArtifactBundle, version: string): ArtifactFile[] {
  const e = bundle.entity;
  const root = `schemas/${e.tenant}/${e.domain}/${e.product}/${e.schema}/${version}/${segment.parse(bundle.format)}`;
  const files = bundle.files.map((file) => ({ ...file, path: `${root}/${file.path}` }));
  files.push({ path: `${root}/superschema-manifest.json`, content: JSON.stringify({ entityId: e.id, format: bundle.format, artifactVersion: bundle.version, sourceEntityVersion: bundle.sourceEntityVersion, contentHash: bundle.contentHash, primaryFile: bundle.primaryFile, files: bundle.files.map((f) => ({ path: f.path, hash: payloadHash(f.content) })) }, null, 2) + "\n" });
  validateFiles(files);
  return files;
}
