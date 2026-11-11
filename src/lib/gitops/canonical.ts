import {
  collectDocumentEdges,
  collectPinSites,
} from "@/lib/events/document/edges";
import { parseEventDocument } from "@/lib/events/document/parse";
import { readFieldReference } from "@/lib/references/entity-reference";
import { minimumVersion } from "./versioning";
import { createHash } from "node:crypto";
import { parseDocument, stringify } from "yaml";
import {
  CanonicalSchema,
  ProductSettingsSchema,
  GitOpsError,
  type CanonicalDocument,
  type ObjectKind,
} from "./contracts";

export const COLLECTIONS: Record<ObjectKind, string> = {
  Tenant: "",
  Domain: "domains",
  Product: "products",
  Entity: "entities",
  Event: "events",
  Trait: "traits",
  Enum: "enums",
  Scalar: "scalars",
  Union: "unions",
  Service: "services",
  Interface: "interfaces",
  Model: "models",
  Decorator: "decorators",
};
export const MODELS: Record<ObjectKind, string> = {
  Tenant: "tenant",
  Domain: "domain",
  Product: "product",
  Entity: "entity",
  Event: "eventSpec",
  Trait: "trait",
  Enum: "sharedEnum",
  Scalar: "customScalar",
  Union: "unionType",
  Service: "serviceDefinition",
  Interface: "interfaceDefinition",
  Model: "modelDefinition",
  Decorator: "decoratorDefinition",
};
export const ROW_FIELDS: Record<ObjectKind, readonly string[]> = {
  Tenant: ["id", "name", "slug", "description"],
  Domain: ["id", "tenantId", "name", "slug", "description", "policyTemplate"],
  Product: [
    "id",
    "domainId",
    "name",
    "slug",
    "description",
    "tierId",
    "ownerTeam",
    "engineeringLead",
    "manager",
    "teamEmails",
  ],
  Entity: [
    "id",
    "name",
    "slug",
    "tenantId",
    "domainId",
    "productId",
    "version",
    "status",
    "ownerId",
    "description",
    "metadata",
    "typespecSource",
    "parentEntityId",
  ],
  Event: [
    "id",
    "name",
    "specType",
    "document",
    "importedSource",
    "sourceVersion",
    "tenantId",
    "domainId",
    "productId",
  ],
  Trait: [
    "id",
    "kind",
    "name",
    "spec",
    "headersEntityId",
    "headersEntityVersionId",
    "tenantId",
    "domainId",
    "productId",
  ],
  Enum: [
    "id",
    "name",
    "values",
    "valueDescriptions",
    "sourceRef",
    "description",
    "tenantId",
    "domainId",
    "productId",
  ],
  Scalar: [
    "id",
    "name",
    "baseType",
    "logicalType",
    "format",
    "pattern",
    "constraints",
    "sourceRef",
    "description",
    "tenantId",
    "domainId",
    "productId",
  ],
  Union: [
    "id",
    "name",
    "memberTypes",
    "description",
    "tenantId",
    "domainId",
    "productId",
  ],
  Service: [
    "id",
    "name",
    "description",
    "basePath",
    "tenantId",
    "domainId",
    "productId",
    "scope",
    "entityId",
  ],
  Interface: ["id", "name", "description", "domainId", "operationIds"],
  Model: [
    "id",
    "name",
    "description",
    "domainId",
    "sourceFormat",
    "sourceNamespace",
    "extendsModelName",
    "metadata",
  ],
  Decorator: [
    "id",
    "name",
    "description",
    "signature",
    "targetTypes",
    "domainId",
  ],
};
export const CHILDREN: Partial<
  Record<
    ObjectKind,
    Record<string, { model: string; parentKey: string; fields: string[] }>
  >
> = {
  Entity: {
    fields: {
      model: "field",
      parentKey: "entityId",
      fields: [
        "id",
        "entityId",
        "name",
        "slug",
        "type",
        "precision",
        "scale",
        "nullable",
        "isKey",
        "fieldNumber",
        "description",
        "aliases",
        "classification",
        "sortOrder",
        "decorators",
      ],
    },
  },
  Model: {
    fields: {
      model: "modelFieldDefinition",
      parentKey: "modelId",
      fields: [
        "id",
        "modelId",
        "name",
        "type",
        "precision",
        "scale",
        "nullable",
        "isKey",
        "description",
        "aliases",
        "classification",
        "sortOrder",
        "decorators",
      ],
    },
  },
  Service: {
    operations: {
      model: "operation",
      parentKey: "serviceId",
      fields: [
        "id",
        "serviceId",
        "name",
        "httpMethod",
        "httpPath",
        "description",
        "operationId",
        "summary",
        "tags",
        "deprecated",
        "requestBody",
        "decorators",
      ],
    },
    parameters: {
      model: "operationParameter",
      parentKey: "operationId",
      fields: [
        "id",
        "operationId",
        "name",
        "type",
        "isArray",
        "location",
        "required",
        "description",
        "sortOrder",
      ],
    },
    responses: {
      model: "operationResponse",
      parentKey: "operationId",
      fields: [
        "id",
        "operationId",
        "statusCode",
        "type",
        "isArray",
        "contentType",
        "description",
        "sortOrder",
      ],
    },
  },
};
export function pickRecord(
  row: Record<string, unknown>,
  keys: readonly string[],
): CanonicalDocument["spec"]["record"] {
  const result = Object.fromEntries(
    keys.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]),
  );
  if (
    result.metadata &&
    typeof result.metadata === "object" &&
    !Array.isArray(result.metadata)
  ) {
    const metadata: Record<string, unknown> = { ...result.metadata };
    delete metadata.schemaVersions;
    delete metadata.schemaCache;
    result.metadata = metadata;
  }
  return JSON.parse(
    JSON.stringify(result),
  ) as CanonicalDocument["spec"]["record"];
}
export function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
export const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(stable(a)) === JSON.stringify(stable(b));
export const objectKey = (
  d: Pick<CanonicalDocument, "kind" | "id" | "version">,
): string => `${d.kind}:${d.id}:${d.version ?? ""}`;
export const objectIdentity = (
  d: Pick<CanonicalDocument, "kind" | "id">,
): string => `${d.kind}:${d.id}`;
export function versionParts(label: string): [number, number, number] {
  const p = label
    .replace(/_snapshot$/, "")
    .split(".")
    .map(Number);
  if (p.length !== 3 || p.some((n) => !Number.isSafeInteger(n) || n < 0))
    throw new GitOpsError(
      "Version components must be safe nonnegative integers",
    );
  return p as [number, number, number];
}
export function compareVersion(a: string, b: string): number {
  const x = versionParts(a),
    y = versionParts(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
export function documentSlug(d: CanonicalDocument): string {
  const s =
    typeof d.spec.record.slug === "string"
      ? d.spec.record.slug
      : String(d.spec.record.name ?? d.id)
          .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s))
    throw new GitOpsError("The document needs a lowercase kebab-case slug");
  return s;
}
export function canonicalPath(base: string, d: CanonicalDocument): string {
  const root = [
    base,
    d.scope.domainSlug && `domains/${d.scope.domainSlug}`,
    d.scope.productSlug && `products/${d.scope.productSlug}`,
  ]
    .filter(Boolean)
    .join("/");
  if (d.kind === "Tenant")
    return [base, "tenant.yaml"].filter(Boolean).join("/");
  if (d.kind === "Domain") return `${root}/domain.yaml`;
  if (d.kind === "Product") return `${root}/product.yaml`;
  return `${root ? `${root}/` : ""}${COLLECTIONS[d.kind]}/${documentSlug(d)}/${d.version}/${d.kind.toLowerCase()}.yaml`;
}
export const stableVersionId = (
  d: Pick<CanonicalDocument, "kind" | "id" | "version">,
): string =>
  "git-" +
  createHash("sha256")
    .update(`${d.kind}:${d.id}:${d.version?.replace(/_snapshot$/, "")}`)
    .digest("hex")
    .slice(0, 32);
export function validateDocument(input: unknown): CanonicalDocument {
  const d = CanonicalSchema.parse(input);
  if (d.kind === "Event" && !parseEventDocument(d.spec.record.document).success)
    throw new GitOpsError("Invalid canonical event source document");
  if (d.kind === "Entity")
    for (const field of d.spec.children.fields ?? []) {
      const ref = readFieldReference(field.decorators);
      if (
        ref?.entityId &&
        !d.references.some(
          (r) =>
            r.kind === "Entity" &&
            r.id === ref.entityId &&
            r.version === ref.pinnedVersion,
        )
      )
        d.references.push({
          kind: "Entity",
          id: ref.entityId,
          ...(ref.pinnedVersion ? { version: ref.pinnedVersion } : {}),
        });
    }
  if (d.configuration) {
    if (d.kind !== "Product")
      throw new GitOpsError(
        "Only product manifests carry workflow configuration",
      );
    ProductSettingsSchema.parse(d.configuration);
    if (!equal(d.owners, d.configuration.owners ?? []))
      throw new GitOpsError("Product owners and workflow owners must agree");
  }
  if (
    (d.kind === "Tenant" && (d.id !== d.scope.tenantId || d.scope.domainId)) ||
    (d.kind === "Domain" && (d.id !== d.scope.domainId || d.scope.productId)) ||
    (d.kind === "Product" && d.id !== d.scope.productId)
  )
    throw new GitOpsError(
      "Hierarchy manifest identity does not match its scope",
    );
  if (
    d.spec.record.id !== d.id ||
    typeof d.spec.record.name !== "string" ||
    !d.spec.record.name.trim()
  )
    throw new GitOpsError("Document id and name must match its record");
  if (
    (d.scope.productId && (!d.scope.domainId || !d.scope.productSlug)) ||
    (d.scope.domainId && !d.scope.domainSlug)
  )
    throw new GitOpsError("Document scope must contain paired ids and slugs");
  for (const key of Object.keys(d.spec.record))
    if (!ROW_FIELDS[d.kind].includes(key))
      throw new GitOpsError(`Unsupported ${d.kind} record property: ${key}`);
  for (const [key, value] of Object.entries(d.spec.record)) {
    if (
      (key === "tenantId" && value !== d.scope.tenantId) ||
      (key === "domainId" && value !== (d.scope.domainId ?? null)) ||
      (key === "productId" && value !== (d.scope.productId ?? null))
    )
      throw new GitOpsError(`Record ${key} does not match the document scope`);
  }
  for (const [name, rows] of Object.entries(d.spec.children)) {
    const child = CHILDREN[d.kind]?.[name];
    if (!child) throw new GitOpsError(`Unsupported child collection: ${name}`);
    const ids = new Set<string>();
    for (const row of rows) {
      if (
        typeof row.id !== "string" ||
        ids.has(row.id) ||
        Object.keys(row).some((key) => !child.fields.includes(key))
      )
        throw new GitOpsError(`Invalid or duplicate child row in ${name}`);
      ids.add(row.id);
      const expected =
        name === "parameters" || name === "responses"
          ? new Set((d.spec.children.operations ?? []).map((o) => o.id))
          : new Set([d.id]);
      if (!expected.has(row[child.parentKey]))
        throw new GitOpsError("Child row belongs to another object");
      if (
        name === "fields" &&
        (typeof row.name !== "string" ||
          typeof row.type !== "string" ||
          typeof row.nullable !== "boolean")
      )
        throw new GitOpsError("Fields require a name, type and nullable flag");
    }
  }
  if (["Tenant", "Domain", "Product"].includes(d.kind)) {
    if (d.version || d.stage)
      throw new GitOpsError("Hierarchy manifests are not versioned");
  } else {
    if (
      !d.version ||
      !d.stage ||
      d.version.endsWith("_snapshot") !== (d.stage === "SNAPSHOT")
    )
      throw new GitOpsError("Version folder and stage disagree");
    versionParts(d.version);
    if (d.deleted && d.stage === "RELEASED")
      throw new GitOpsError("A released document cannot be a tombstone");
  }
  if (d.kind === "Entity" || d.kind === "Event") {
    d.spec.versionRecord ??= {};
    d.spec.versionRecord.id ??= stableVersionId(d);
    if (
      typeof d.spec.versionRecord.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(d.spec.versionRecord.id)
    )
      throw new GitOpsError("A stable frozen version id is required");
  }
  return d;
}
export function serializeDocument(input: unknown): string {
  return stringify(stable(validateDocument(input)), {
    lineWidth: 0,
    sortMapEntries: true,
  });
}
export function parseCanonical(text: string): CanonicalDocument {
  if (Buffer.byteLength(text) > 5 * 1024 * 1024)
    throw new GitOpsError("Canonical document exceeds 5 MiB");
  const parsed = parseDocument(text, { uniqueKeys: true, strict: true });
  if (parsed.errors.length)
    throw new GitOpsError(
      parsed.errors
        .map((e) => e.message)
        .join("; ")
        .slice(0, 2000),
    );
  return validateDocument(parsed.toJS({ maxAliasCount: 0 }));
}
export const blobHash = (text: string): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
export function validateRepository(
  files: { path: string; content: string }[],
  base: string,
  previous: { path: string; content: string }[] = [],
  external: CanonicalDocument[] = [],
): {
  documents: { path: string; content: string; document: CanonicalDocument }[];
  errors: { path: string; message: string }[];
} {
  const documents: {
      path: string;
      content: string;
      document: CanonicalDocument;
    }[] = [],
    errors: { path: string; message: string }[] = [];
  const keys = new Set<string>(),
    snapshots = new Set<string>();
  for (const file of files) {
    try {
      const document = parseCanonical(file.content);
      const expected = canonicalPath(base, document);
      if (expected !== file.path) {
        const a = expected.split("/"),
          b = file.path.split("/"),
          slugIndex = a.length - 3;
        if (
          document.stage !== "RELEASED" ||
          a.length !== b.length ||
          a.some((v, i) => i !== slugIndex && v !== b[i]) ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(b[slugIndex] ?? "")
        )
          throw new GitOpsError(
            "Canonical file path does not match its scope, kind, slug and version",
          );
      }
      if (keys.has(objectKey(document)))
        throw new GitOpsError("Duplicate canonical object version");
      keys.add(objectKey(document));
      if (document.stage === "SNAPSHOT") {
        if (snapshots.has(objectIdentity(document)))
          throw new GitOpsError("Only one snapshot may exist per object");
        snapshots.add(objectIdentity(document));
      }
      documents.push({ ...file, document });
    } catch (e) {
      errors.push({
        path: file.path,
        message: e instanceof Error ? e.message : "Invalid canonical document",
      });
    }
  }
  const all = [...documents.map((d) => d.document), ...external],
    byKey = new Map(all.map((d) => [objectKey(d), d]));
  const frozenIds = new Map<string, string>();
  for (const d of all) {
    if (d.kind !== "Entity" && d.kind !== "Event") continue;
    const key = `${d.kind}:${d.spec.versionRecord?.id}`,
      identity = objectKey(d),
      previous = frozenIds.get(key);
    if (previous && previous !== identity)
      errors.push({
        path:
          documents.find((f) => f.document === d)?.path ??
          canonicalPath(base, d),
        message: "Frozen version id is reused by another canonical version",
      });
    frozenIds.set(key, identity);
  }
  for (const entry of documents) {
    const d = entry.document;
    for (const ref of d.references) {
      const target = ref.version
        ? byKey.get(objectKey(ref))
        : all
            .filter((r) => r.kind === ref.kind && r.id === ref.id && !r.deleted)
            .toSorted(
              (a, b) =>
                (a.stage === "RELEASED" ? -1 : 1) -
                  (b.stage === "RELEASED" ? -1 : 1) ||
                compareVersion(b.version ?? "0.0.0", a.version ?? "0.0.0"),
            )[0];
      if (
        !target ||
        target.deleted ||
        (d.stage === "RELEASED" && target.stage !== "RELEASED")
      )
        errors.push({
          path: entry.path,
          message: `Reference ${ref.kind}:${ref.id}:${ref.version ?? "latest"} is missing or not released`,
        });
    }
    if (d.kind === "Event") {
      const parsed = parseEventDocument(d.spec.record.document);
      if (parsed.success) {
        for (const edge of collectDocumentEdges(parsed.data)) {
          const kind = edge.toKind === "ENTITY_VERSION" ? "Entity" : "Event";
          const target = all.find(
            (x) => x.kind === kind && x.spec.versionRecord?.id === edge.toId,
          );
          if (
            !target ||
            target.deleted ||
            target.scope.tenantId !== d.scope.tenantId ||
            (d.stage === "RELEASED" && target.stage !== "RELEASED")
          )
            errors.push({
              path: entry.path,
              message: `Pinned ${kind} version ${edge.toId} is missing or not released`,
            });
        }
        for (const site of collectPinSites(parsed.data)) {
          const target = all.find(
            (x) =>
              x.kind === "Entity" &&
              x.id === site.pin.entityId &&
              (!site.pin.entityVersionId ||
                x.spec.versionRecord?.id === site.pin.entityVersionId),
          );
          if (
            !target ||
            target.deleted ||
            (d.stage === "RELEASED" && !site.pin.entityVersionId)
          )
            errors.push({
              path: entry.path,
              message: `Event entity pin ${site.pin.entityId} is missing or unpinned`,
            });
        }
      }
    }
    const parentDomain = d.scope.domainId
      ? all.find((x) => x.kind === "Domain" && x.id === d.scope.domainId)
      : undefined;
    const parentProduct = d.scope.productId
      ? all.find((x) => x.kind === "Product" && x.id === d.scope.productId)
      : undefined;
    if (
      !all.some((x) => x.kind === "Tenant" && x.id === d.scope.tenantId) ||
      (d.scope.domainId && !parentDomain) ||
      (d.scope.productId && !parentProduct)
    )
      errors.push({
        path: entry.path,
        message: "Canonical hierarchy manifest is missing",
      });
    if (
      (parentDomain && parentDomain.scope.tenantId !== d.scope.tenantId) ||
      (parentProduct &&
        (parentProduct.scope.tenantId !== d.scope.tenantId ||
          parentProduct.scope.domainId !== d.scope.domainId))
    )
      errors.push({
        path: entry.path,
        message: "Canonical hierarchy crosses a tenant or domain boundary",
      });
    if (d.stage === "SNAPSHOT") {
      const releases = all.filter(
        (r) =>
          objectIdentity(r) === objectIdentity(d) && r.stage === "RELEASED",
      );
      const latest = releases.toSorted((a, b) =>
        compareVersion(b.version!, a.version!),
      )[0];
      if (compareVersion(d.version!, minimumVersion(latest, d)) < 0)
        errors.push({
          path: entry.path,
          message: "Snapshot version is below its required semantic bump",
        });
      if (releases.some((r) => compareVersion(d.version!, r.version!) <= 0))
        errors.push({
          path: entry.path,
          message: "Snapshot version must exceed every release",
        });
    }
  }
  for (const old of previous) {
    try {
      const d = parseCanonical(old.content);
      if (d.stage !== "RELEASED") continue;
      const next = documents.find(
        (n) => objectKey(n.document) === objectKey(d),
      );
      if (!next || next.content !== old.content)
        errors.push({
          path: old.path,
          message:
            "Released content is immutable; only byte-identical moves are allowed",
        });
    } catch {
      errors.push({
        path: old.path,
        message: "The previous canonical tree is invalid",
      });
    }
  }
  return { documents, errors };
}
export function promoteDocument(input: CanonicalDocument): CanonicalDocument {
  const d = structuredClone(validateDocument(input));
  if (d.stage !== "SNAPSHOT")
    throw new GitOpsError("Only a snapshot can be promoted");
  const from = d.version!,
    to = from.replace(/_snapshot$/, "");
  function rewrite(value: unknown, key = ""): unknown {
    if (Array.isArray(value)) return value.map((v) => rewrite(v, key));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, rewrite(v, k)]),
      );
    if (
      typeof value === "string" &&
      (key === "version" || key === "dataschema" || key === "$id")
    )
      return value === from ? to : value.replaceAll(`/${from}/`, `/${to}/`);
    return value;
  }
  d.version = to;
  d.stage = "RELEASED";
  d.spec = rewrite(d.spec) as CanonicalDocument["spec"];
  if (d.spec.versionRecord) {
    d.spec.versionRecord.stage = "RELEASED";
    d.spec.versionRecord.releasedAt = new Date().toISOString();
  }
  return d;
}

export const rootedPath = (root: string, path: string): string =>
  [root, path].filter(Boolean).join("/");
export const isWithinRoot = (root: string, path: string): boolean =>
  !root || path.startsWith(`${root}/`);
