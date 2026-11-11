import {
  replaceReferences,
  type ReferenceEdge,
} from "@/services/events/schema-references";
import { projectEventVersions } from "./project-events";
import { loadEntityApiOperations } from "@/lib/api-operations/load-entity-operations";
import {
  readEntitySnapshot,
  entitySnapshotReport,
} from "@/lib/entity-versioning/entity-snapshot";
import {
  compileEntity,
  type PrismaEntityInput,
  type PrismaFieldInput,
} from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  CHILDREN,
  MODELS,
  ROW_FIELDS,
  compareVersion,
  objectIdentity,
  pickRecord,
  serializeDocument,
  stableVersionId,
  validateDocument,
} from "./canonical";
import {
  GitOpsError,
  type CanonicalDocument,
  type ObjectKind,
  type Scope,
} from "./contracts";
import { withProjectionWrites } from "./mode";

type Row = Record<string, unknown> & { id: string };
type Db = PrismaClient | Prisma.TransactionClient;
interface Delegate {
  findUnique(args: unknown): Promise<Row | null>;
  findMany(args: unknown): Promise<Row[]>;
  upsert(args: unknown): Promise<Row>;
  update(args: unknown): Promise<Row>;
  deleteMany(args: unknown): Promise<{ count: number }>;
}
const delegate = (db: Db, model: string): Delegate =>
  (db as unknown as Record<string, Delegate>)[model];

const label = (v: Row) =>
  `${v.major}.${v.minor}.${v.patch ?? 0}${v.stage === "SNAPSHOT" ? "_snapshot" : ""}`;
export const VERSION_FIELDS = [
  "id",
  "major",
  "minor",
  "patch",
  "stage",
  "sequence",
  "resolvedSource",
  "fieldSnapshot",
  "document",
  "sourceDocument",
  "frozenTraits",
  "resolvedSpec",
  "changeKind",
  "compatReport",
  "changeSummary",
  "publishedById",
  "publishedAt",
  "governanceRequestId",
  "releasedAt",
  "releasedById",
  "updatedAt",
];

async function childrenOf(
  db: Db,
  kind: ObjectKind,
  id: string,
): Promise<CanonicalDocument["spec"]["children"]> {
  const result: CanonicalDocument["spec"]["children"] = {};
  for (const [name, config] of Object.entries(CHILDREN[kind] ?? {})) {
    const where =
      name === "parameters" || name === "responses"
        ? { operationId: { in: (result.operations ?? []).map((o) => o.id) } }
        : { [config.parentKey]: id };
    const rows = await delegate(db, config.model).findMany({
      where,
      orderBy: { id: "asc" },
    });
    result[name] = rows.map((row) => pickRecord(row, config.fields));
  }
  return result;
}
async function referencesOf(
  db: Db,
  kind: ObjectKind,
  versionId: string,
): Promise<CanonicalDocument["references"]> {
  if (kind !== "Entity" && kind !== "Event" && kind !== "Trait") return [];
  const refs = await db.schemaReference.findMany({
    where: { fromId: versionId },
  });
  const result: CanonicalDocument["references"] = [];
  for (const ref of refs) {
    if (ref.toKind === "ENTITY_VERSION") {
      const v = await db.entityVersion.findUnique({ where: { id: ref.toId } });
      if (v)
        result.push({
          kind: "Entity",
          id: v.entityId,
          version: label(v),
          role: ref.role,
        });
    }
    if (ref.toKind === "EVENT_SPEC_VERSION") {
      const v = await db.eventSpecVersion.findUnique({
        where: { id: ref.toId },
      });
      if (v)
        result.push({
          kind: "Event",
          id: v.eventSpecId,
          version: label(v),
          role: ref.role,
        });
    }
  }
  return result;
}
/** Full frozen version rows are carried verbatim; generated artifact caches are excluded from canonical content. */
export async function exportProduct(
  db: Db,
  productId: string,
): Promise<CanonicalDocument[]> {
  const product = await db.product.findUniqueOrThrow({
    where: { id: productId },
    include: { domain: { include: { tenant: true } } },
  });
  const scope: Scope = {
    tenantId: product.domain.tenantId,
    tenantSlug: product.domain.tenant.slug,
    domainId: product.domainId,
    domainSlug: product.domain.slug,
    productId: product.id,
    productSlug: product.slug,
  };
  const hierarchy: [ObjectKind, Row, Scope][] = [
    [
      "Tenant",
      product.domain.tenant,
      { tenantId: scope.tenantId, tenantSlug: scope.tenantSlug },
    ],
    [
      "Domain",
      product.domain,
      {
        tenantId: scope.tenantId,
        tenantSlug: scope.tenantSlug,
        domainId: scope.domainId,
        domainSlug: scope.domainSlug,
      },
    ],
    ["Product", product, scope],
  ];
  const docs: CanonicalDocument[] = hierarchy.map(([kind, row, s]) =>
    validateDocument({
      apiVersion: "superschema.io/v1",
      kind,
      id: row.id,
      scope: s,
      spec: { record: pickRecord(row, ROW_FIELDS[kind]), children: {} },
      owners: [],
      references: [],
    }),
  );
  const settings = await db.productGitSettings.findUnique({
    where: { productId },
  });
  if (settings) {
    const manifest = docs.find((d) => d.kind === "Product")!;
    manifest.owners = settings.owners;
    manifest.configuration = JSON.parse(
      JSON.stringify({
        owners: settings.owners,
        stages: settings.stages,
        targets: settings.targets,
        ...(settings.repositoryUrl
          ? { repositoryUrl: settings.repositoryUrl }
          : {}),
        ...(settings.installationId
          ? { installationId: settings.installationId }
          : {}),
        ...(settings.branch ? { branch: settings.branch } : {}),
        ...(settings.basePath !== null ? { basePath: settings.basePath } : {}),
      }),
    );
  }
  for (const kind of [
    "Entity",
    "Event",
    "Trait",
    "Enum",
    "Scalar",
    "Union",
    "Service",
    "Interface",
    "Model",
    "Decorator",
  ] as const) {
    const where =
      kind === "Model" || kind === "Decorator" || kind === "Interface"
        ? { domainId: product.domainId }
        : kind === "Service"
          ? {
              tenantId: scope.tenantId,
              domainId: product.domainId,
              OR: [{ productId }, { productId: null }],
            }
          : {
              tenantId: scope.tenantId,
              OR: [
                { productId },
                { productId: null, domainId: product.domainId },
                { productId: null, domainId: null },
              ],
            };
    const rows = await delegate(db, MODELS[kind]).findMany({
      where,
      orderBy: { id: "asc" },
    });
    for (const row of rows) {
      const ownScope: Scope = row.productId
        ? scope
        : row.domainId
          ? {
              tenantId: scope.tenantId,
              tenantSlug: scope.tenantSlug,
              domainId: scope.domainId,
              domainSlug: scope.domainSlug,
            }
          : { tenantId: scope.tenantId, tenantSlug: scope.tenantSlug };
      const children = await childrenOf(db, kind, row.id);
      const record = pickRecord(row, ROW_FIELDS[kind]);
      const versionModel =
        kind === "Entity"
          ? "entityVersion"
          : kind === "Event"
            ? "eventSpecVersion"
            : null;
      const versions = versionModel
        ? await delegate(db, versionModel).findMany({
            where: { [kind === "Entity" ? "entityId" : "eventSpecId"]: row.id },
            orderBy: { sequence: "asc" },
          })
        : [];
      for (const v of versions) {
        const frozen = structuredClone({ record, children });
        if (kind === "Event" && v.sourceDocument)
          frozen.record.document = JSON.parse(JSON.stringify(v.sourceDocument));
        if (kind === "Entity") {
          const snapshot = readEntitySnapshot(v.compatReport);
          if (snapshot)
            Object.assign(
              frozen.record,
              pickRecord(snapshot as unknown as Record<string, unknown>, [
                "name",
                "description",
                "status",
                "metadata",
              ]),
            );
        }
        if (kind === "Entity" && Array.isArray(v.fieldSnapshot))
          frozen.children.fields = v.fieldSnapshot.map((f) =>
            pickRecord(
              {
                ...f,
                entityId: row.id,
                slug: f.slug ?? String(f.name).toLowerCase(),
              },
              CHILDREN.Entity!.fields.fields,
            ),
          );
        docs.push(
          validateDocument({
            apiVersion: "superschema.io/v1",
            kind,
            id: row.id,
            scope: ownScope,
            version: label(v),
            stage: v.stage,
            spec: { ...frozen, versionRecord: pickRecord(v, VERSION_FIELDS) },
            references: await referencesOf(db, kind, v.id),
            owners: [],
          }),
        );
      }
      if (!versions.length || row.hasUnpublishedChanges) {
        const snapshot = versions.find((v) => v.stage === "SNAPSHOT");
        const latest = versions.at(-1);
        const version = snapshot
          ? label(snapshot)
          : latest
            ? `${latest.major}.${Number(latest.minor) + 1}.0_snapshot`
            : "1.0.0_snapshot";
        const d = validateDocument({
          apiVersion: "superschema.io/v1",
          kind,
          id: row.id,
          scope: ownScope,
          version,
          stage: "SNAPSHOT",
          spec: { record, children },
          references: [],
          owners: [],
        });
        const existing = docs.findIndex(
          (v) =>
            objectIdentity(v) === objectIdentity(d) && v.stage === "SNAPSHOT",
        );
        if (existing >= 0) docs.splice(existing, 1);
        docs.push(d);
      }
    }
  }
  return docs;
}
async function requireOwned(
  db: Db,
  kind: ObjectKind,
  d: CanonicalDocument,
): Promise<void> {
  const old = await delegate(db, MODELS[kind]).findUnique({
    where: { id: d.id },
  });
  if (!old) return;
  if (
    ("tenantId" in old && old.tenantId !== d.scope.tenantId) ||
    ("domainId" in old && old.domainId !== (d.scope.domainId ?? null)) ||
    ("productId" in old && old.productId !== (d.scope.productId ?? null))
  )
    throw new GitOpsError(
      "A stable object id already belongs to another scope",
    );
}
/** The only writer of the published projection in Git mode. It runs after complete-tree validation, in one transaction. */
export async function rebuildProjection(
  db: PrismaClient,
  docs: CanonicalDocument[],
  fallbackUserId: string,
  commit?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  await withProjectionWrites(() =>
    db.$transaction(
      async (tx) => {
        const sorted = docs.toSorted(
          (a, b) =>
            ["Tenant", "Domain", "Product"].indexOf(a.kind) -
            ["Tenant", "Domain", "Product"].indexOf(b.kind),
        );
        const groups = new Map<string, CanonicalDocument[]>();
        for (const d of sorted) {
          const k = objectIdentity(d);
          groups.set(k, [...(groups.get(k) ?? []), d]);
        }
        // Parent manifests first, then all root objects, then children and frozen versions; foreign keys never see a partial graph.
        const entries = [...groups.values()]
          .map((versions) => ({
            versions,
            latest: versions.toSorted((a, b) =>
              compareVersion(b.version ?? "0.0.0", a.version ?? "0.0.0"),
            )[0],
          }))
          .toSorted(
            (a, b) =>
              ((
                ({ Tenant: 0, Domain: 1, Product: 2 }) as Partial<
                  Record<ObjectKind, number>
                >
              )[a.latest.kind] ?? 3) -
              ((
                { Tenant: 0, Domain: 1, Product: 2 } as Partial<
                  Record<ObjectKind, number>
                >
              )[b.latest.kind] ?? 3),
          );
        for (const { latest: d } of entries) {
          await requireOwned(tx, d.kind, d);
          const data: Record<string, unknown> = pickRecord(
            d.spec.record,
            ROW_FIELDS[d.kind],
          );
          if (d.kind === "Tenant" && data.id !== d.scope.tenantId)
            throw new GitOpsError(
              "Tenant manifest identity does not match its binding",
            );
          if (d.kind === "Entity") {
            const before = await tx.entity.findUnique({
              where: { id: d.id },
              select: { metadata: true },
            });
            const metadata =
              data.metadata &&
              typeof data.metadata === "object" &&
              !Array.isArray(data.metadata)
                ? (data.metadata as Record<string, unknown>)
                : {};
            const previous =
              before?.metadata &&
              typeof before.metadata === "object" &&
              !Array.isArray(before.metadata)
                ? (before.metadata as Record<string, unknown>)
                : {};
            for (const key of ["schemaVersions", "schemaCache"])
              if (key in previous) metadata[key] = previous[key];
            data.metadata = metadata;
            data.ownerId = (await tx.user.findUnique({
              where: { id: String(data.ownerId) },
            }))
              ? data.ownerId
              : fallbackUserId;
            data.hasUnpublishedChanges = false;
            if (d.deleted) data.status = "RETIRED";
            delete data.parentEntityId;
          }
          if (d.kind === "Event") data.hasUnpublishedChanges = false;
          await delegate(tx, MODELS[d.kind]).upsert({
            where: { id: d.id },
            create: data,
            update: data,
          });
        }
        for (const { latest: d } of entries) {
          if (d.kind === "Entity" && d.spec.record.parentEntityId)
            await tx.entity.update({
              where: { id: d.id },
              data: { parentEntityId: String(d.spec.record.parentEntityId) },
            });
          for (const [name, config] of Object.entries(CHILDREN[d.kind] ?? {})) {
            const rows = d.spec.children[name] ?? [];
            const parentIds =
              name === "parameters" || name === "responses"
                ? (d.spec.children.operations ?? []).map((o) => o.id)
                : [d.id];
            await delegate(tx, config.model).deleteMany({
              where: {
                [config.parentKey]: { in: parentIds },
                id: { notIn: rows.map((row) => row.id) },
              },
            });
            for (const row of rows) {
              const old = await delegate(tx, config.model).findUnique({
                where: { id: row.id },
              });
              if (old && old[config.parentKey] !== row[config.parentKey])
                throw new GitOpsError("A child id belongs to another object");
              await delegate(tx, config.model).upsert({
                where: { id: row.id },
                create: row,
                update: row,
              });
            }
          }
        }
        for (const { latest: d, versions } of entries) {
          if (d.kind !== "Entity") continue;
          const model =
              d.kind === "Entity" ? "entityVersion" : "eventSpecVersion",
            parentKey = d.kind === "Entity" ? "entityId" : "eventSpecId";
          const existing = await delegate(tx, model).findMany({
            where: { [parentKey]: d.id },
          });
          let sequence = Math.max(
            0,
            ...existing.map((v) => Number(v.sequence)),
          );
          let latestId: string | undefined;
          for (const v of versions.toSorted((a, b) =>
            compareVersion(a.version!, b.version!),
          )) {
            const [major, minor, patch] = v
              .version!.replace(/_snapshot$/, "")
              .split(".")
              .map(Number);
            const old =
              existing.find(
                (row) =>
                  row.major === major &&
                  row.minor === minor &&
                  row.patch === patch,
              ) ??
              (v.stage === "SNAPSHOT"
                ? existing.find((row) => row.stage === "SNAPSHOT")
                : undefined);
            if (old?.stage === "RELEASED") {
              latestId = old.id;
              continue;
            }
            const stored = pickRecord(
              v.spec.versionRecord ?? {},
              VERSION_FIELDS,
            );
            const publishedById =
              typeof stored.publishedById === "string" &&
              (await tx.user.findUnique({
                where: { id: stored.publishedById },
              }))
                ? stored.publishedById
                : fallbackUserId;
            const data: Record<string, unknown> = {
              ...stored,
              id: old?.id ?? stored.id ?? stableVersionId(v),
              [parentKey]: d.id,
              major,
              minor,
              patch,
              stage: v.stage,
              sequence: old?.sequence ?? ++sequence,
              changeKind: stored.changeKind ?? "INITIAL",
              publishedById,
              publishedAt: stored.publishedAt ?? new Date().toISOString(),
              releasedAt:
                v.stage === "RELEASED"
                  ? (stored.releasedAt ?? new Date().toISOString())
                  : null,
              releasedById: v.stage === "RELEASED" ? publishedById : null,
            };
            if (d.kind === "Entity") {
              const row = v.spec.record,
                entity: PrismaEntityInput = {
                  id: d.id,
                  name: String(row.name),
                  description: String(row.description ?? ""),
                  status: String(row.status ?? "DRAFT"),
                  version: Number(row.version ?? 1),
                  domainId: v.scope.domainId ?? null,
                  metadata: row.metadata,
                  apiOperations: await loadEntityApiOperations(tx, d.id),
                  domain: v.scope.domainId
                    ? {
                        id: v.scope.domainId,
                        name: v.scope.domainSlug!,
                        slug: v.scope.domainSlug!,
                      }
                    : null,
                };
              data.resolvedSource =
                stored.resolvedSource ??
                generateTypeSpec(
                  compileEntity(
                    entity,
                    (v.spec.children.fields ??
                      []) as unknown as PrismaFieldInput[],
                  ),
                );
              data.fieldSnapshot =
                stored.fieldSnapshot ?? v.spec.children.fields ?? [];
              data.compatReport =
                stored.compatReport ?? entitySnapshotReport(entity);
            } else {
              data.document = stored.document ?? v.spec.record.document;
              data.sourceDocument =
                stored.sourceDocument ?? v.spec.record.document;
              data.frozenTraits = stored.frozenTraits ?? [];
            }
            if (typeof data.id !== "string")
              throw new GitOpsError("Invalid frozen version identity");
            const collision = await delegate(tx, model).findUnique({
              where: { id: data.id },
            });
            if (collision && collision[parentKey] !== d.id)
              throw new GitOpsError(
                "Frozen version id belongs to another object",
              );
            latestId = (
              await delegate(tx, model).upsert({
                where: { id: data.id },
                create: data,
                update: data,
              })
            ).id;
          }
          if (latestId)
            await delegate(tx, MODELS[d.kind]).update({
              where: { id: d.id },
              data: {
                latestVersionId: latestId,
                ...(d.kind === "Entity" ? { version: sequence } : {}),
              },
            });
        }
        await projectEventVersions(tx, docs, fallbackUserId);
        for (const d of docs.filter((x) => x.kind === "Entity")) {
          const edges: ReferenceEdge[] = [];
          for (const ref of d.references.filter((r) => r.kind === "Entity")) {
            const versions = await tx.entityVersion.findMany({
              where: { entityId: ref.id },
              orderBy: [
                { major: "desc" },
                { minor: "desc" },
                { patch: "desc" },
              ],
            });
            const target = ref.version
              ? versions.find((v) => label(v) === ref.version)
              : (versions.find((v) => v.stage === "RELEASED") ?? versions[0]);
            if (target)
              edges.push({
                role: ref.role ?? "FIELD",
                toKind: "ENTITY_VERSION",
                toId: target.id,
              });
          }
          await replaceReferences(
            tx,
            {
              kind: "ENTITY_VERSION",
              id: String(d.spec.versionRecord?.id ?? stableVersionId(d)),
            },
            edges,
            d.stage === "SNAPSHOT",
          );
        }
        if (commit) await commit(tx);
      },
      { timeout: 60000 },
    ),
  );
}
export const canonicalFiles = (base: string, docs: CanonicalDocument[]) =>
  docs.map((document) => ({
    document,
    content: serializeDocument(document),
    base,
  }));
