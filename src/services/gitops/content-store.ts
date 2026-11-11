import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { ctxCan, type ActionId } from "@/lib/access";
import type { ChangeSet } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { minimumVersion } from "@/lib/gitops/versioning";
import {
  canonicalPath,
  compareVersion,
  equal,
  objectKey,
  parseCanonical,
  documentSlug,
  pickRecord,
  promoteDocument,
  serializeDocument,
  stableVersionId,
  validateDocument,
  validateRepository,
} from "@/lib/gitops/canonical";
import {
  DraftSchema,
  GitOpsError,
  type CanonicalDocument,
  type FileChange,
  type ObjectKind,
} from "@/lib/gitops/contracts";
import { mergeDocuments } from "@/lib/gitops/merge";
import { exportProduct, VERSION_FIELDS } from "@/lib/gitops/projection";
import {
  bindingFor,
  json,
  productFor,
  providerFor,
  requireAccess,
  type ProviderFactory,
} from "./settings";

const actionFor = (kind: ObjectKind): ActionId =>
  kind === "Entity"
    ? "entity.write"
    : kind === "Event"
      ? "event.write"
      : kind === "Trait"
        ? "trait.write"
        : kind === "Tenant"
          ? "tenant.admin"
          : kind === "Domain"
            ? "domain.update"
            : kind === "Product"
              ? "product.update"
              : "asset.write";
function mayEdit(doc: CanonicalDocument, ctx: ServiceContext): void {
  requireAccess(ctx, actionFor(doc.kind), {
    tenantId: doc.scope.tenantId,
    domainId: doc.scope.domainId,
    productId: doc.scope.productId,
  });
}
async function ownedSet(id: string, ctx: ServiceContext): Promise<ChangeSet> {
  const cs = await prisma.changeSet.findUnique({ where: { id } });
  if (!cs || cs.authorId !== ctx.userId)
    throw new GitOpsError("Change set not found", "NOT_FOUND");
  await productFor(cs.productId, ctx, "entity.write");
  return cs;
}
async function openSet(productId: string, ctx: ServiceContext, kind = "EDIT") {
  const p = await productFor(productId, ctx, "entity.write"),
    { binding } = await bindingFor(productId),
    openKey = `${ctx.userId}:${productId}:${kind}`;
  return prisma.changeSet.upsert({
    where: { openKey },
    create: {
      tenantId: p.domain.tenantId,
      productId,
      authorId: ctx.userId,
      kind,
      openKey,
      baseSha: binding.indexedSha,
    },
    update: {},
  });
}
export interface ContentStore {
  saveDraft(
    input: unknown,
    revision: number | undefined,
    ctx: ServiceContext,
  ): Promise<ChangeSet>;
  discard(id: string, ctx: ServiceContext): Promise<void>;
  submit(
    id: string,
    title: string,
    description: string,
    ctx: ServiceContext,
  ): Promise<ChangeSet>;
  promote(
    productId: string,
    key: string,
    ctx: ServiceContext,
  ): Promise<ChangeSet>;
}
export class GitContentStore implements ContentStore {
  constructor(private readonly provider: ProviderFactory = providerFor) {}
  async saveDraft(
    input: unknown,
    revision: number | undefined,
    ctx: ServiceContext,
  ): Promise<ChangeSet> {
    const data = DraftSchema.parse(input),
      p = await productFor(data.productId, ctx, "entity.write"),
      { binding } = await bindingFor(data.productId);
    if (!binding.indexedSha)
      throw new GitOpsError(
        "Merge and synchronize the bootstrap PR before editing this binding",
        "BOOTSTRAP_REQUIRED",
      );
    const doc = validateDocument(data.document);
    if (doc.stage === "SNAPSHOT") {
      const releases = await prisma.gitCanonicalDocument.findMany({
        where: {
          bindingId: binding.id,
          kind: doc.kind,
          objectId: doc.id,
          stage: "RELEASED",
        },
      });
      const latest = releases.toSorted((a, b) =>
        compareVersion(b.version, a.version),
      )[0];
      const minimum = minimumVersion(
        latest ? validateDocument(latest.document) : undefined,
        doc,
      );
      if (compareVersion(doc.version!, minimum) < 0) {
        doc.version = minimum;
        if (doc.spec.versionRecord)
          doc.spec.versionRecord.id = stableVersionId(doc);
      }
    }
    if (
      doc.scope.tenantId !== p.domain.tenantId ||
      (doc.scope.domainId && doc.scope.domainId !== p.domainId) ||
      (doc.scope.productId && doc.scope.productId !== p.id)
    )
      throw new GitOpsError(
        "Draft does not belong to this product or its shared scope",
      );
    mayEdit(doc, ctx);
    if (doc.stage === "RELEASED")
      throw new GitOpsError(
        "Edit a snapshot; use Promote to create a released version",
      );
    const cs = await openSet(p.id, ctx);
    if (["MERGED", "CLOSED"].includes(cs.state))
      throw new GitOpsError("This change set is closed");
    const key = objectKey(doc),
      base = await prisma.gitCanonicalDocument.findFirst({
        where: {
          bindingId: binding.id,
          kind: doc.kind,
          objectId: doc.id,
          ...(doc.stage === "SNAPSHOT"
            ? { stage: "SNAPSHOT" }
            : { version: doc.version ?? "" }),
        },
      });
    if (base && !equal(base.document, doc) && doc.spec.versionRecord) {
      const original = validateDocument(base.document);
      doc.spec.versionRecord = {
        id: original.spec.versionRecord?.id ?? doc.spec.versionRecord.id!,
      };
    }
    if (data.operation === "DELETE") doc.deleted = true;
    const lineage =
      base ??
      (
        await prisma.gitCanonicalDocument.findMany({
          where: {
            bindingId: binding.id,
            kind: doc.kind,
            objectId: doc.id,
            stage: "RELEASED",
          },
        })
      ).toSorted((a, b) => compareVersion(b.version, a.version))[0];
    const path = canonicalPath(binding.basePath, doc);
    return prisma.$transaction(async (tx) => {
      if (
        (
          await tx.changeSet.updateMany({
            where: {
              id: cs.id,
              revision: revision ?? cs.revision,
              OR: [{ leasedUntil: null }, { leasedUntil: { lt: new Date() } }],
            },
            data: {
              revision: { increment: 1 },
              state: cs.prNumber ? cs.state : "DRAFT",
            },
          })
        ).count !== 1
      )
        throw new GitOpsError(
          "The change set changed in another tab; refresh before saving",
          "CONFLICT",
        );
      await tx.changeSetItem.deleteMany({
        where: {
          changeSetId: cs.id,
          objectId: doc.id,
          objectKind: doc.kind,
          objectKey: { not: key },
        },
      });
      await tx.changeSetItem.upsert({
        where: {
          changeSetId_objectKey: { changeSetId: cs.id, objectKey: key },
        },
        create: {
          changeSetId: cs.id,
          objectKey: key,
          objectKind: doc.kind,
          objectId: doc.id,
          operation: data.operation,
          path,
          oldPath: base?.path !== path ? base?.path : undefined,
          baseBlobSha: base?.blobSha,
          baseDocument: base?.document ?? PrismaJsonNull(),
          document: json(doc),
        },
        update: {
          document: json(doc),
          operation: data.operation,
          path,
          oldPath: base?.path !== path ? base?.path : null,
          outOfDate: false,
          conflicts: [],
        },
      });
      if (
        lineage &&
        doc.version &&
        documentSlug(validateDocument(lineage.document)) !== documentSlug(doc)
      ) {
        for (const released of await tx.gitCanonicalDocument.findMany({
          where: {
            bindingId: binding.id,
            kind: doc.kind,
            objectId: doc.id,
            stage: "RELEASED",
          },
        })) {
          const frozen = validateDocument(released.document),
            parts = released.path.split("/");
          parts[parts.length - 3] = documentSlug(doc);
          const moved = parts.join("/");
          await tx.changeSetItem.upsert({
            where: {
              changeSetId_objectKey: {
                changeSetId: cs.id,
                objectKey: objectKey(frozen),
              },
            },
            create: {
              changeSetId: cs.id,
              objectKey: objectKey(frozen),
              objectKind: doc.kind,
              objectId: doc.id,
              operation: "RENAME",
              path: moved,
              oldPath: released.path,
              baseBlobSha: released.blobSha,
              baseDocument: json(frozen),
              document: json(frozen),
              contentOverride: released.content,
            },
            update: { path: moved, contentOverride: released.content },
          });
        }
      }
      return tx.changeSet.findUniqueOrThrow({ where: { id: cs.id } });
    });
  }
  async bootstrap(productId: string, ctx: ServiceContext): Promise<ChangeSet> {
    const p = await productFor(productId, ctx, "deploy.run"),
      { binding } = await bindingFor(productId);
    requireAccess(ctx, "deploy.configure", { tenantId: p.domain.tenantId });
    const existing = await prisma.gitCanonicalDocument.count({
      where: { bindingId: binding.id, productId },
    });
    if (existing)
      throw new GitOpsError(
        "This product is already indexed; edit its snapshots instead",
      );
    const cs = await openSet(productId, ctx, "BOOTSTRAP"),
      docs = await exportProduct(prisma, productId);
    const remote = await this.provider(binding, ctx.userId),
      sha = await remote.base(binding.branch);
    await prisma.$transaction(async (tx) => {
      await tx.changeSetItem.deleteMany({ where: { changeSetId: cs.id } });
      for (const d of docs) {
        // Existing shared ancestors and versions stay byte-identical when bootstrapping another product.
        if (
          await tx.gitCanonicalDocument.findFirst({
            where: {
              bindingId: binding.id,
              kind: d.kind,
              objectId: d.id,
              version: d.version ?? "",
            },
          })
        )
          continue;
        await tx.changeSetItem.create({
          data: {
            changeSetId: cs.id,
            objectKey: objectKey(d),
            objectKind: d.kind,
            objectId: d.id,
            operation: "CREATE",
            path: canonicalPath(binding.basePath, d),
            document: json(d),
          },
        });
      }
      await tx.changeSet.update({
        where: { id: cs.id },
        data: {
          baseSha: sha,
          title: `Initialize ${p.name} in Git`,
          revision: { increment: 1 },
        },
      });
    });
    return prisma.changeSet.findUniqueOrThrow({ where: { id: cs.id } });
  }
  async submit(
    id: string,
    title: string,
    description: string,
    ctx: ServiceContext,
  ): Promise<ChangeSet> {
    const cs = await ownedSet(id, ctx),
      { binding } = await bindingFor(cs.productId);
    if (!title.trim() || title.length > 250 || description.length > 20000)
      throw new GitOpsError(
        "Supply a PR title of at most 250 characters and a bounded description",
      );
    if (["MERGED", "CLOSED"].includes(cs.state))
      throw new GitOpsError("This change set is closed");
    const lease = randomUUID();
    if (
      (
        await prisma.changeSet.updateMany({
          where: {
            id,
            revision: cs.revision,
            OR: [{ leasedUntil: null }, { leasedUntil: { lt: new Date() } }],
          },
          data: {
            leaseToken: lease,
            leasedUntil: new Date(Date.now() + 5 * 60000),
          },
        })
      ).count !== 1
    )
      throw new GitOpsError("This change set is busy; refresh and try again");
    try {
      const items = await prisma.changeSetItem.findMany({
        where: { changeSetId: id },
      });
      if (!items.length) throw new GitOpsError("The change set has no changes");
      if (items.some((i) => i.outOfDate))
        throw new GitOpsError(
          "Refresh and resolve every stale draft before submitting",
          "OUT_OF_DATE",
        );
      const remote = await this.provider(binding, ctx.userId),
        sha = await remote.base(binding.branch);
      const prefix = binding.basePath ? `${binding.basePath}/` : "";
      const base = await remote.readFiles(
        sha,
        (path) =>
          path.startsWith(prefix) &&
          /(?:tenant|domain|product|entity|event|trait|enum|scalar|union|service|interface|model|decorator)\.yaml$/.test(
            path,
          ),
      );
      const candidate = new Map(
        base.map((f) => [f.path, { path: f.path, content: f.content }]),
      );
      const files: FileChange[] = [];
      for (const item of items) {
        if (!item.document) throw new GitOpsError("Draft document is missing");
        const d = validateDocument(item.document);
        mayEdit(d, ctx);
        const old = base.find((f) => f.path === (item.oldPath ?? item.path));
        if (cs.kind !== "BOOTSTRAP" && (old?.sha ?? null) !== item.baseBlobSha)
          throw new GitOpsError(
            `Draft ${item.objectId} is out of date; refresh before submitting`,
            "OUT_OF_DATE",
          );
        if (
          cs.kind === "BOOTSTRAP" &&
          old &&
          !equal(parseCanonical(old.content), d)
        )
          throw new GitOpsError(
            "Bootstrap would overwrite existing canonical content",
          );
        if (item.oldPath && item.oldPath !== item.path) {
          candidate.delete(item.oldPath);
          files.push({ path: item.oldPath, content: null });
        }
        const content = item.contentOverride ?? serializeDocument(d);
        candidate.set(item.path, { path: item.path, content });
        files.push({ path: item.path, content });
      }
      const external = (
        await prisma.gitCanonicalDocument.findMany({
          where: { tenantId: cs.tenantId, bindingId: { not: binding.id } },
        })
      )
        .map((d) => validateDocument(d.document))
        .filter((d) =>
          ctxCan(ctx, d.kind === "Event" ? "event.read" : "entity.read", {
            tenantId: d.scope.tenantId,
            domainId: d.scope.domainId,
            productId: d.scope.productId,
          }),
        );
      const validation = validateRepository(
        [...candidate.values()],
        binding.basePath,
        base,
        external,
      );
      if (validation.errors.length)
        throw new GitOpsError(
          validation.errors
            .map((e) => `${e.path}: ${e.message}`)
            .join("\n")
            .slice(0, 12000),
          "VALIDATION_ERROR",
        );
      const branch = cs.branch ?? `ss/${cs.productId}/${cs.id}`;
      await prisma.changeSet.update({
        where: { id },
        data: { branch, baseSha: sha, title: title.trim(), description },
      });
      const overlaps = await prisma.changeSetItem.findMany({
        where: {
          objectId: { in: items.map((i) => i.objectId) },
          changeSetId: { not: id },
        },
      });
      const result = await remote.commit({
        baseBranch: binding.branch,
        baseSha: sha,
        branch,
        root: binding.basePath,
        expectedHead: cs.headSha ?? undefined,
        files,
        title: title.trim(),
        body: `${description}\n\nSuper Schema ${cs.kind.toLowerCase()} change set ${id}.\nProduct: ${cs.productId}\nAuthor: ${ctx.userId}\n\nOverlapping drafts: ${new Set(overlaps.map((o) => o.changeSetId)).size}.\n\nAll canonical documents and pinned references validated. GitHub review and merge are the approval gates.`,
        marker: `SuperSchema-ChangeSet: ${id}`,
      });
      return await prisma.$transaction(async (tx) => {
        for (const item of items)
          if (item.document)
            await tx.changeSetItem.update({
              where: { id: item.id },
              data: { submittedDocument: json(item.document) },
            });
        return tx.changeSet.update({
          where: { id },
          data: {
            title: title.trim(),
            description,
            branch,
            baseSha: sha,
            headSha: result.sha,
            prNumber: result.prNumber,
            prUrl: result.prUrl,
            state: "IN_REVIEW",
            revision: { increment: 1 },
          },
        });
      });
    } finally {
      await prisma.changeSet.updateMany({
        where: { id, leaseToken: lease },
        data: { leaseToken: null, leasedUntil: null },
      });
    }
  }
  async refresh(
    id: string,
    ctx: ServiceContext,
  ): Promise<{ conflicts: number }> {
    const cs = await ownedSet(id, ctx),
      { binding } = await bindingFor(cs.productId),
      remote = await this.provider(binding),
      sha = await remote.base(binding.branch);
    const files = await remote.readFiles(
      sha,
      (path) =>
        path.startsWith(binding.basePath ? `${binding.basePath}/` : "") &&
        path.endsWith(".yaml"),
    );
    const pr = cs.prNumber ? await remote.pullRequest(cs.prNumber) : null;
    const branchFiles =
      pr && pr.headSha !== cs.headSha
        ? await remote.readFiles(
            pr.headSha,
            (p) =>
              p.startsWith(binding.basePath ? `${binding.basePath}/` : "") &&
              p.endsWith(".yaml"),
          )
        : null;
    return prisma.$transaction(async (tx) => {
      if (
        (
          await tx.changeSet.updateMany({
            where: {
              id,
              revision: cs.revision,
              OR: [{ leasedUntil: null }, { leasedUntil: { lt: new Date() } }],
            },
            data: { revision: { increment: 1 } },
          })
        ).count !== 1
      )
        throw new GitOpsError(
          "The change set changed; reload before refreshing",
        );
      let conflicts = 0;
      for (const item of await tx.changeSetItem.findMany({
        where: { changeSetId: id },
      })) {
        const file = files.find((f) => f.path === (item.oldPath ?? item.path)),
          theirs = file ? parseCanonical(file.content) : null;
        let value: unknown = item.document;
        const issues: unknown[] = [];
        if ((file?.sha ?? null) !== item.baseBlobSha) {
          const merged = mergeDocuments(item.baseDocument, theirs, value);
          value = merged.value;
          issues.push(...merged.conflicts);
        }
        if (branchFiles) {
          const branchFile = branchFiles.find((f) => f.path === item.path),
            branchDoc = branchFile ? parseCanonical(branchFile.content) : null;
          const merged = mergeDocuments(
            item.submittedDocument ?? item.baseDocument,
            branchDoc,
            value,
          );
          value = merged.value;
          issues.push(...merged.conflicts);
        }
        conflicts += issues.length;
        await tx.changeSetItem.update({
          where: { id: item.id },
          data: {
            baseDocument: theirs ? json(theirs) : PrismaJsonNull(),
            baseBlobSha: file?.sha ?? null,
            document: value ? json(value) : PrismaJsonNull(),
            outOfDate: issues.length > 0,
            conflicts: json(issues),
          },
        });
      }
      await tx.changeSet.update({
        where: { id },
        data: {
          baseSha: sha,
          ...(pr ? { headSha: pr.headSha } : {}),
          state: conflicts
            ? "OUT_OF_DATE"
            : cs.prNumber
              ? "IN_REVIEW"
              : "DRAFT",
        },
      });
      return { conflicts };
    });
  }

  async promote(
    productId: string,
    key: string,
    ctx: ServiceContext,
  ): Promise<ChangeSet> {
    const p = await productFor(productId, ctx, "entity.publish");
    const { binding } = await bindingFor(productId),
      row = await prisma.gitCanonicalDocument.findFirst({
        where: {
          bindingId: binding.id,
          tenantId: p.domain.tenantId,
          stage: "SNAPSHOT",
          OR: [{ id: key }, { objectId: key }],
        },
      });
    if (!row) throw new GitOpsError("Snapshot not found");
    const original = validateDocument(row.document);
    if (
      (original.scope.productId && original.scope.productId !== productId) ||
      (original.scope.domainId && original.scope.domainId !== p.domainId)
    )
      throw new GitOpsError("Snapshot belongs to another product or domain");
    mayEdit(original, ctx);
    if (original.kind === "Entity") {
      const version = await prisma.entityVersion.findUnique({
        where: { id: String(original.spec.versionRecord?.id) },
      });
      if (version)
        original.spec.versionRecord = pickRecord(version, VERSION_FIELDS);
    }
    if (original.kind === "Event") {
      const version = await prisma.eventSpecVersion.findUnique({
        where: { id: String(original.spec.versionRecord?.id) },
      });
      if (version)
        original.spec.versionRecord = pickRecord(version, VERSION_FIELDS);
    }
    const doc = promoteDocument(original),
      cs = await openSet(productId, ctx, "PROMOTION");
    await prisma.changeSetItem.upsert({
      where: {
        changeSetId_objectKey: {
          changeSetId: cs.id,
          objectKey: objectKey(doc),
        },
      },
      create: {
        changeSetId: cs.id,
        objectKey: objectKey(doc),
        objectKind: doc.kind,
        objectId: doc.id,
        operation: "RENAME",
        path: canonicalPath(binding.basePath, doc),
        oldPath: row.path,
        baseBlobSha: row.blobSha,
        baseDocument: json(row.document),
        document: json(doc),
      },
      update: { document: json(doc) },
    });
    return cs;
  }
  async discard(id: string, ctx: ServiceContext): Promise<void> {
    const cs = await ownedSet(id, ctx);
    if (cs.state === "MERGED")
      throw new GitOpsError("A merged change set cannot be discarded");
    if (cs.prNumber) {
      const { binding } = await bindingFor(cs.productId);
      await (await this.provider(binding, ctx.userId)).close(cs.prNumber);
    }
    await prisma.$transaction(async (tx) => {
      await tx.changeSetItem.deleteMany({ where: { changeSetId: id } });
      await tx.changeSet.update({
        where: { id },
        data: { state: "CLOSED", openKey: null, revision: { increment: 1 } },
      });
    });
  }
}
// Prisma distinguishes SQL NULL from JSON null on optional JSON columns.
import { Prisma as PrismaRuntime } from "@/generated/prisma/client";
const PrismaJsonNull = () => PrismaRuntime.DbNull;
