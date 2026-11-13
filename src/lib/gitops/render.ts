import { readEntitySnapshot } from "@/lib/entity-versioning/entity-snapshot";
import type { CanonicalDocument } from "./contracts";
import { GitOpsError } from "./contracts";
import { compareVersion, documentSlug } from "./canonical";
import type {
  PrismaEntityInput,
  PrismaFieldInput,
} from "@/lib/compiler/compiler.service";
import type { ClosureEntity } from "@/lib/references/closure";
import {
  readFieldReference,
  qualifiedName,
} from "@/lib/references/entity-reference";
import { emitClosureTarget } from "@/lib/emission/closure-generation";
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";
import type { ArtifactFile } from "@/lib/deployments/contracts";

function member(d: CanonicalDocument, all: CanonicalDocument[]): ClosureEntity {
  const r = d.spec.record,
    domain = all.find((x) => x.kind === "Domain" && x.id === d.scope.domainId),
    product = all.find(
      (x) => x.kind === "Product" && x.id === d.scope.productId,
    );
  const metadata =
    r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata)
      ? { ...r.metadata }
      : {};
  const frozen = !!d.spec.versionRecord?.compatReport;
  const custom =
    metadata.custom &&
    typeof metadata.custom === "object" &&
    !Array.isArray(metadata.custom)
      ? { ...metadata.custom }
      : {};
  const visible = all.filter(
    (x) =>
      x.scope.tenantId === d.scope.tenantId &&
      (!x.scope.domainId || x.scope.domainId === d.scope.domainId) &&
      (!x.scope.productId || x.scope.productId === d.scope.productId),
  );
  for (const [kind, key] of [
    ["Enum", "sharedEnums"],
    ["Scalar", "customScalars"],
    ["Union", "unionTypes"],
    ["Interface", "interfaces"],
  ] as const)
    if (!frozen || !Array.isArray(custom[key]))
      custom[key] = visible
        .filter((x) => x.kind === kind)
        .map((x) => x.spec.record);
  metadata.custom = custom;
  const entity: PrismaEntityInput = {
    id: d.id,
    name: String(r.name),
    description: String(r.description ?? ""),
    status: String(r.status ?? "ACTIVE"),
    version: Number(r.version ?? 1),
    apiOperations: readEntitySnapshot(d.spec.versionRecord?.compatReport)
      ?.apiOperations,
    domainId: d.scope.domainId ?? null,
    metadata,
    domain: domain
      ? {
          id: domain.id,
          name: String(domain.spec.record.name),
          slug: domain.scope.domainSlug!,
        }
      : null,
  };
  const fields = (d.spec.children.fields ?? []).map((f) => ({
    id: String(f.id),
    name: String(f.name),
    type: String(f.type),
    precision: f.precision ?? null,
    scale: f.scale ?? null,
    nullable: f.nullable,
    isKey: f.isKey ?? false,
    fieldNumber: f.fieldNumber ?? null,
    description: f.description ?? "",
    classification: f.classification ?? null,
    aliases: f.aliases ?? [],
    decorators: f.decorators ?? {},
    sortOrder: f.sortOrder ?? 0,
  })) as PrismaFieldInput[];
  return {
    entityId: d.id,
    entity,
    fields,
    source: "pinned",
    version: d.version,
    ref: {
      entityId: d.id,
      domain: String(domain?.spec.record.name ?? "tenant"),
      product: String(product?.spec.record.name ?? "tenant"),
      entity: String(r.name),
    },
  };
}
function choose(
  versions: CanonicalDocument[],
  version?: string,
): CanonicalDocument | undefined {
  return version
    ? versions.find((d) => d.version === version)
    : versions.toSorted(
        (a, b) =>
          (a.stage === "RELEASED" ? -1 : 1) -
            (b.stage === "RELEASED" ? -1 : 1) ||
          compareVersion(b.version!, a.version!),
      )[0];
}
export function frozenClosure(
  root: CanonicalDocument,
  all: CanonicalDocument[],
) {
  const selected = new Map<string, CanonicalDocument>(),
    edges = new Map<string, string[]>();
  function visit(d: CanonicalDocument): void {
    const old = selected.get(d.id);
    if (old) {
      if (old.version !== d.version)
        throw new GitOpsError(
          "The artifact closure pins conflicting versions of one entity",
        );
      return;
    }
    if (selected.size >= 200)
      throw new GitOpsError("Artifact closure exceeds 200 entities");
    selected.set(d.id, d);
    const refs = [...d.references.filter((r) => r.kind === "Entity")];
    for (const field of d.spec.children.fields ?? []) {
      const ref = readFieldReference(field.decorators);
      if (!ref) continue;
      const versions = all.filter(
        (x) =>
          x.kind === "Entity" &&
          x.scope.tenantId === d.scope.tenantId &&
          (ref.entityId
            ? x.id === ref.entityId
            : String(x.spec.record.name) ===
              ("legacyName" in ref ? ref.legacyName : ref.entity)),
      );
      const ids = new Set(versions.map((x) => x.id));
      if (ids.size !== 1)
        throw new GitOpsError(
          "An artifact field reference is missing or ambiguous",
        );
      refs.push({
        kind: "Entity",
        id: versions[0].id,
        version: ref.pinnedVersion,
      });
    }
    edges.set(d.id, []);
    for (const ref of refs) {
      const next = choose(
        all.filter((x) => x.kind === "Entity" && x.id === ref.id),
        ref.version,
      );
      if (!next)
        throw new GitOpsError(
          "An artifact reference is missing from its frozen source commit",
        );
      if (root.stage === "RELEASED" && next.stage !== "RELEASED")
        throw new GitOpsError(
          "Release artifacts cannot use snapshot references",
        );
      edges.get(d.id)!.push(next.id);
      visit(next);
    }
  }
  visit(root);
  const nodes = [...selected.values()].map((d) => member(d, all)),
    byId = new Map(nodes.map((n) => [n.entityId, n]));
  const cycles: string[][] = [];
  let index = 0;
  const indexes = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: string[] = [],
    active = new Set<string>();
  function scc(id: string) {
    indexes.set(id, index);
    low.set(id, index++);
    stack.push(id);
    active.add(id);
    for (const next of edges.get(id) ?? []) {
      if (!indexes.has(next)) {
        scc(next);
        low.set(id, Math.min(low.get(id)!, low.get(next)!));
      } else if (active.has(next))
        low.set(id, Math.min(low.get(id)!, indexes.get(next)!));
    }
    if (low.get(id) === indexes.get(id)) {
      const group: string[] = [];
      let n: string;
      do {
        n = stack.pop()!;
        active.delete(n);
        group.push(n);
      } while (n !== id);
      if (group.length > 1 || edges.get(id)?.includes(id))
        cycles.push(
          group.map((x) => {
            const r = byId.get(x)!.ref;
            return qualifiedName(r);
          }),
        );
    }
  }
  for (const id of selected.keys()) if (!indexes.has(id)) scc(id);
  return {
    root: byId.get(root.id)!,
    entities: nodes,
    cycles,
    draftEntities: [],
  };
}
/** Actual TypeSpec emitters consume only the frozen canonical commit, never a later live projection. */
export async function renderCanonicalArtifact(
  root: CanonicalDocument,
  target: string,
  all: CanonicalDocument[],
  fallbackUserId: string,
): Promise<ArtifactFile[]> {
  if (root.kind === "Event")
    return renderEvent(root, target, all, fallbackUserId);
  if (root.kind !== "Entity") return [];
  const definition = getSchemaTargetCatalog().find(
    (t) => t.key === target && t.enabledInSchemaTab,
  );
  if (!definition) throw new GitOpsError(`Target ${target} is not enabled`);
  // `internal` metadata attributes stay in the canonical GitOps source but not in the emitted artifacts.
  const { loadMetadataEmission } = await import(
    "@/services/metadata-emission.service"
  );
  const metadata = await loadMetadataEmission(root.scope.tenantId);
  const run = metadata ? { metadata } : {};
  const closure = frozenClosure(root, all),
    result = definition.closureEmission
      ? await emitClosureTarget(closure, definition.key, run)
      : await emitOfficialTypeSpecTargetFromData(
          closure.root.entity,
          closure.root.fields,
          definition.key,
          run,
        );
  if (result.validationStatus === "INVALID" || result.busy)
    throw new GitOpsError(
      `Artifact generation for ${target} failed: ${result.errors.map((e) => e.message).join("; ")}`,
    );
  const files =
    "files" in result && Array.isArray(result.files)
      ? (result.files as ArtifactFile[])
      : undefined;
  return files?.length
    ? files.map((f) => ({
        path: f.path,
        content: f.content,
        ...(f.entityId ? { entityId: f.entityId } : {}),
      }))
    : [
        {
          path: `${documentSlug(root)}.${definition.targetFormat}`,
          content: result.output,
        },
      ];
}
async function renderEvent(
  root: CanonicalDocument,
  target: string,
  all: CanonicalDocument[],
  fallbackUserId: string,
): Promise<ArtifactFile[]> {
  if (target !== "asyncapi") return [];
  const frozen = root.spec.versionRecord?.document;
  if (
    frozen &&
    typeof frozen === "object" &&
    !Array.isArray(frozen) &&
    typeof frozen.asyncapi === "string"
  ) {
    const { stringify } = await import("yaml");
    return [
      {
        path: `${documentSlug(root)}.asyncapi.json`,
        content: JSON.stringify(frozen, null, 2) + "\n",
      },
      {
        path: `${documentSlug(root)}.asyncapi.yaml`,
        content: stringify(frozen),
      },
    ];
  }
  const [
    { PGlite },
    { PrismaPGlite },
    { applyPgliteMigrations },
    { PrismaClient },
    { rebuildProjection },
    { emitEventDocumentPreview },
    { stringify },
  ] = await Promise.all([
    import("@electric-sql/pglite"),
    import("@/lib/pglite-adapter"),
    import("@/lib/pglite-migrate"),
    import("@/generated/prisma/client"),
    import("./projection"),
    import("@/services/events/event-emit.service"),
    import("yaml"),
  ]);
  const pg = new PGlite();
  let db: InstanceType<typeof PrismaClient> | undefined;
  try {
    await applyPgliteMigrations(pg);
    db = new PrismaClient({ adapter: new PrismaPGlite(pg) });
    await db.user.create({
      data: { id: fallbackUserId, email: "gitops-render@example.invalid" },
    });
    await rebuildProjection(db, all, fallbackUserId);
    const output = await emitEventDocumentPreview(
      root.id,
      root.scope.productId!,
      root.spec.record.document,
      {
        userId: fallbackUserId,
        userRole: "VIEWER",
        tenantId: root.scope.tenantId,
        assignments: [
          {
            role: "ADMIN",
            scope: { kind: "TENANT", tenantId: root.scope.tenantId },
          },
        ],
        prisma: db,
      },
    );
    if (
      !output.success ||
      !output.data.document ||
      output.data.diagnostics.some((d) => d.severity === "error")
    )
      throw new GitOpsError(
        "The frozen event document failed AsyncAPI validation",
      );
    const document = {
      ...output.data.document,
      info: {
        ...(output.data.document.info as Record<string, unknown>),
        version: root.version,
      },
    };
    return [
      {
        path: `${documentSlug(root)}.asyncapi.json`,
        content: JSON.stringify(document, null, 2) + "\n",
      },
      {
        path: `${documentSlug(root)}.asyncapi.yaml`,
        content: stringify(document),
      },
    ];
  } finally {
    await db?.$disconnect();
    await pg.close();
  }
}
