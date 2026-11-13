/**
 * GitOps `renderEvent` (a non-frozen event document): the AsyncAPI artifact is rendered against an in-memory projection DB that holds no
 * metadata attribute dictionary. The tenant's dictionary must come from the live DB, so an `internal` attribute never reaches the artifact.
 *
 * The projection DB and the event preview are stubbed (the preview renders one entity version payload through the renderer it is handed,
 * the default renderer otherwise, exactly as the real one picks it); the renderer and the JSON Schema emitter are real.
 */
import { describe, expect, it, vi } from "vitest";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => {
  const ext = (openapi: Record<string, unknown>) => ({ typespec: { extensions: { openapi } } });
  const base = { precision: null, scale: null, nullable: false, isKey: false, fieldNumber: null, description: "", aliases: [], classification: null };
  const fields = [
    { ...base, id: "f1", name: "email", type: "string", sortOrder: 0, decorators: ext({ "x-securityClassification": { data_class: "class2", data_category: "ConsumerPersonal" } }) },
    { ...base, id: "f2", name: "note", type: "string", sortOrder: 1, decorators: ext({ "x-review-note": "check with legal" }) },
  ];
  return { fields, live: vi.fn() };
});

vi.mock("server-only", () => ({}));
vi.mock("@electric-sql/pglite", () => ({ PGlite: class { async close() {} } }));
vi.mock("@/lib/pglite-adapter", () => ({ PrismaPGlite: class {} }));
vi.mock("@/lib/pglite-migrate", () => ({ applyPgliteMigrations: async () => {} }));
vi.mock("@/lib/gitops/projection", () => ({ rebuildProjection: async () => {} }));
// The live DB's dictionary for tenant t1.
vi.mock("@/services/metadata-emission.service", () => ({ loadMetadataEmission: h.live }));
vi.mock("@/generated/prisma/client", async (importOriginal) => {
  const { compileEntity } = await import("@/lib/compiler/compiler.service");
  const { generateTypeSpec } = await import("@/lib/compiler/typespec-generator");
  const entity = { id: "e1", name: "Customer", description: "", status: "DRAFT", version: 1, domainId: null, metadata: null, domain: null };
  /** The projection DB of the render: the frozen entity version, and (like a real projection) no dictionary rows. */
  class ProjectionClient {
    user = { create: async () => ({}) };
    entityVersion = {
      findUnique: async () => ({
        id: "v1", entityId: "e1", major: 1, minor: 0, patch: 0, stage: "RELEASED",
        resolvedSource: generateTypeSpec(compileEntity(entity, h.fields as never)), fieldSnapshot: h.fields,
        entity: { name: "Customer", tenantId: "t1", domainId: null, productId: null, product: null },
      }),
    };
    schemaReference = { findMany: async () => [] };
    entity = { findUnique: async () => ({ tenant: { slug: "acme" }, domain: null, product: null }) };
    metadataAttributeDefinition = { findMany: async () => [] };
    async $disconnect() {}
  }
  return { ...(await importOriginal<object>()), PrismaClient: ProjectionClient };
});
vi.mock("@/services/events/event-emit.service", async () => {
  const { assembleAsyncApi3 } = await import("@/lib/event-specs/assemble");
  const { createArtifactRenderer } = await import("@/services/events/artifact-renderer");
  return {
    emitEventDocumentPreview: async (_id: string, _product: string, _doc: unknown, ctx: { tenantId: string; prisma: never }, deps: { renderer?: import("@/services/events/artifact-renderer").ArtifactRenderer } = {}) => {
      // The real preview uses `deps.renderer`, else a renderer on `ctx.prisma` whose dictionary is read from that client.
      const renderer = deps.renderer ?? createArtifactRenderer({ db: ctx.prisma, loadMetadata: async () => undefined });
      const rendered = await renderer.render({ kind: "version", entityVersionId: "v1", tenantId: ctx.tenantId }, "json-schema");
      if (!rendered.success) throw new Error(rendered.error.message);
      const { document, diagnostics } = assembleAsyncApi3({
        productSlug: "sales", info: { title: "customers", version: "1.0" }, servers: [], traits: [], components: {},
        operations: [{ key: "publish", action: "send", channelRef: "ch", messageRefs: ["m"], traitRefs: [] }],
        channels: [{ id: "ch", name: "customers", productSlug: "sales", address: "customers.v1", protocol: "kafka", profile: { format: "json-schema", dialect: "2020-12" } }],
        messages: [{ id: "m", name: "CustomerChanged", productSlug: "sales", traitRefs: [], payloads: [rendered.data.artifact] }],
      });
      return { success: true, data: { document, diagnostics } };
    },
  };
});

import { renderCanonicalArtifact } from "@/lib/gitops/render";

const REVIEW = {
  key: "x-review-note", label: "Review note", description: "", valueSchema: { type: "string" }, targets: ["field"],
  scope: "internal", placement: "field", requiredWhen: "never",
} as MetadataAttributeDefinition;

describe("GitOps renderEvent with a projection DB", () => {
  it("strips an internal attribute defined on the LIVE tenant from the AsyncAPI artifacts", async () => {
    h.live.mockImplementation(async (tenantId: string) => (tenantId === "t1" ? { definitions: [REVIEW] } : undefined));
    const root = {
      kind: "Event", id: "ev1", version: "1.0.0", scope: { tenantId: "t1", productId: "p1" },
      spec: { record: { slug: "customer-changed", document: {} } },
    };
    const files = await renderCanonicalArtifact(root as never, "asyncapi", [root as never], "user-1");
    expect(h.live).toHaveBeenCalledWith("t1");
    expect(files.map((f) => f.path)).toEqual(["customer-changed.asyncapi.json", "customer-changed.asyncapi.yaml"]);
    for (const f of files) {
      expect(f.content).toContain("x-securityClassification");
      expect(f.content).not.toContain("x-review-note");
    }
  });
});
