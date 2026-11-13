import { prisma } from "@/lib/db";
import { projectionTransaction } from "@/lib/gitops/projection-transaction";
import { bundleEmittedFiles } from "@/lib/typespec-official/closure-emit";
import type { CanonicalDocument } from "@/lib/gitops/contracts";
import type { ArtifactFile } from "@/lib/deployments/contracts";
import { json } from "./settings";
/** Generated schemas remain a rebuildable cache; the canonical source stays in Git. */
export async function cacheGitArtifact(
  doc: CanonicalDocument,
  target: string,
  files: ArtifactFile[],
  sha: string,
) {
  if (doc.kind !== "Entity") return;
  await projectionTransaction(prisma, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "entities" WHERE "id" = ${doc.id} FOR UPDATE`;
    const row = await tx.entity.findUnique({ where: { id: doc.id } });
    if (!row) return;
    const metadata =
      row.metadata &&
      typeof row.metadata === "object" &&
      !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};
    const versions =
      metadata.schemaVersions &&
      typeof metadata.schemaVersions === "object" &&
      !Array.isArray(metadata.schemaVersions)
        ? (metadata.schemaVersions as Record<string, Record<string, unknown>[]>)
        : {};
    const list = Array.isArray(versions[target]) ? versions[target] : [];
    if (
      list.some(
        (v) =>
          v.gitCanonicalCommit === sha && v.gitCanonicalVersion === doc.version,
      )
    )
      return;
    const [major, minor, patch] = doc
        .version!.replace(/_snapshot$/, "")
        .split(".")
        .map(Number),
      source = await tx.entityVersion.findUnique({
        where: {
          entityId_major_minor_patch: {
            entityId: doc.id,
            major,
            minor,
            patch,
          },
        },
      });
    const entry = {
      version: Math.max(0, ...list.map((v) => Number(v.version) || 0)) + 1,
      status: "published",
      output: bundleEmittedFiles(files),
      files,
      primaryFile:
        files.find((f) => f.entityId === doc.id)?.path ?? files[0]?.path,
      generatedAt: new Date().toISOString(),
      entityVersion: source?.sequence ?? row.version,
      gitCanonicalCommit: sha,
      gitCanonicalVersion: doc.version,
    };
    await tx.entity.update({
      where: { id: doc.id },
      data: {
        metadata: json({
          ...metadata,
          schemaVersions: { ...versions, [target]: [...list, entry] },
        }),
      },
    });
  });
}
