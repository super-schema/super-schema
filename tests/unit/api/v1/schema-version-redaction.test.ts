// @vitest-environment node
/**
 * KD-046 on /api/v1: `GET /schemas/:id` answers the entity with its metadata, and the metadata holds the stored generated schemas
 * (`schemaVersions`), each with the files of every entity of the closure it was made from. Through the REAL guard, principal loader and entity
 * service (the session and the database are stand-ins): the answer keeps the shape the API documents (`{ success, data }`, `data.metadata.schemaVersions[target][n]`
 * with `version`, `status`, `output`, `files`, `resolution`) and holds only what the caller's roles cover. Whole for a tenant administrator, a platform
 * administrator and the API key (a service principal over the tenant).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assign, sessionOf, userRow } from "../../../helpers/access-mocks";
import type { Assignment } from "@/lib/access";
import type { SchemaVersionsMap } from "@/types/schema-version";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  activeTenant: vi.fn(),
  prisma: { user: { findUnique: vi.fn() }, entity: { findMany: vi.fn(), findUnique: vi.fn() } },
}));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/active-tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/active-tenant")>()), getActiveTenantId: h.activeTenant }));
vi.mock("@/app/api/v1/rate-limit", () => ({ checkRateLimit: () => null }));

import { GET } from "@/app/api/v1/schemas/[id]/route";

const SAVED = { ...process.env };
const KEY = "the-key-of-the-run";
const T = "t1";
const withId = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string, init: RequestInit = {}) => GET(new Request(`http://localhost/api/v1/schemas/${id}`, init), withId(id));
const bodyOf = async (response: Response) => JSON.parse(await response.text());

// "order" (domain sales) has a version made by a tenant administrator over the closure order -> invoice (sales) and customer (finance).
const PLACES: Record<string, { domainId: string; productId: string }> = {
  order: { domainId: "d-sales", productId: "p-orders" },
  invoice: { domainId: "d-sales", productId: "p-orders" },
  customer: { domainId: "d-finance", productId: "p-ledger" },
};
const file = (path: string, content: string, entityId: string) => ({ path, content, target: "json-schema", entityId });
const FILES = [file("Order.json", '{"title":"Order"}', "order"), file("Invoice.json", '{"title":"Invoice"}', "invoice"), file("Customer.json", '{"title":"Customer","properties":{"iban":{}}}', "customer")];
const OUTPUT = FILES.map((f) => `===== ${f.path} =====\n${f.content}`).join("\n\n");
const STORED: SchemaVersionsMap = {
  "json-schema": [
    {
      version: 1,
      status: "draft",
      output: OUTPUT,
      generatedAt: "2026-01-01T00:00:00.000Z",
      entityVersion: 1,
      files: FILES as never,
      resolution: {
        mode: "draft",
        preview: true,
        entities: FILES.map((f) => ({ ref: { entityId: f.entityId, domain: "d", product: "p", entity: f.path.replace(".json", "") }, source: "draft" as const })),
      },
    },
  ],
};

const entityRow = (id: string) => ({
  id, tenantId: T, name: id, description: "", status: "DRAFT", version: 1, slug: id, ownerId: "o", typespecSource: null, parentEntityId: null, latestVersionId: null,
  hasUnpublishedChanges: false, createdAt: new Date(), updatedAt: new Date(), ...PLACES[id],
  metadata: id === "order" ? { tags: ["t"], schemaVersions: STORED } : null,
  domain: { id: PLACES[id].domainId, name: PLACES[id].domainId, slug: PLACES[id].domainId }, fields: [], product: { domainId: PLACES[id].domainId },
});

function signIn(assignments: Assignment[]) {
  h.auth.mockResolvedValue(sessionOf("user-1"));
  h.prisma.user.findUnique.mockResolvedValue(userRow(assignments, { id: "user-1" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.API_KEY;
  delete process.env.API_KEY_ROLE;
  delete process.env.API_KEY_TENANT_ID;
  h.activeTenant.mockResolvedValue(T);
  h.prisma.entity.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (PLACES[where.id] ? entityRow(where.id) : null));
  // The places of the entities a version names (the one lookup the redaction makes).
  h.prisma.entity.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.filter((id) => PLACES[id]).map((id) => ({ id, tenantId: T, ...PLACES[id], product: { domainId: PLACES[id].domainId } }))
  );
});
afterEach(() => {
  process.env = { ...SAVED };
});

describe("GET /api/v1/schemas/:id", () => {
  it("a domain-scoped AUTHOR of sales gets the documented shape with only the files of what sales covers, and `output` rebuilt from them", async () => {
    signIn([assign.domain("AUTHOR", T, "d-sales")]);
    const response = await get("order");
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ success: true, data: { id: "order", name: "order", status: "DRAFT", version: 1, metadata: { tags: ["t"] } } });
    const version = body.data.metadata.schemaVersions["json-schema"][0];
    expect(Object.keys(version).sort()).toEqual(["entityVersion", "files", "generatedAt", "output", "redacted", "resolution", "status", "version"]);
    expect(version.files.map((f: { path: string }) => f.path)).toEqual(["Order.json", "Invoice.json"]);
    expect(version.output).toBe(`===== Order.json =====\n{"title":"Order"}\n\n===== Invoice.json =====\n{"title":"Invoice"}`);
    expect(version.redacted).toEqual({ hiddenFiles: 1, hiddenEntities: 1 });
    expect(version.resolution.entities.map((e: { ref: { entityId: string } }) => e.ref.entityId)).toEqual(["order", "invoice"]);
    expect(JSON.stringify(body)).not.toMatch(/Customer|iban/);
  });

  it("a user who covers sales only through a product role still gets nothing of finance", async () => {
    signIn([assign.product("VIEWER", T, "d-sales", "p-orders")]);
    const body = await bodyOf(await get("order"));
    expect(JSON.stringify(body)).not.toMatch(/Customer|iban/);
    expect(body.data.metadata.schemaVersions["json-schema"][0].files).toHaveLength(2);
  });

  it.each([
    ["a tenant administrator", [assign.tenant("ADMIN", T)]],
    ["a tenant-wide viewer", [assign.tenant("VIEWER", T)]],
    ["a platform administrator", [assign.global()]],
    ["a user who holds sales AND finance", [assign.domain("VIEWER", T, "d-sales"), assign.domain("VIEWER", T, "d-finance")]],
  ] as Array<[string, Assignment[]]>)("%s gets the stored versions whole (no `redacted` mark)", async (_who, assignments) => {
    signIn(assignments);
    const body = await bodyOf(await get("order"));
    expect(body.data.metadata.schemaVersions).toEqual(JSON.parse(JSON.stringify(STORED)));
  });

  it("the API key (a service principal over the tenant) gets them whole, with the default ADMIN role and as a tenant-wide VIEWER", async () => {
    process.env.API_KEY = KEY;
    process.env.API_KEY_TENANT_ID = T;
    const headers = { authorization: `Bearer ${KEY}` };
    expect((await bodyOf(await get("order", { headers }))).data.metadata.schemaVersions).toEqual(JSON.parse(JSON.stringify(STORED)));
    process.env.API_KEY_ROLE = "VIEWER";
    expect((await bodyOf(await get("order", { headers }))).data.metadata.schemaVersions).toEqual(JSON.parse(JSON.stringify(STORED)));
  });

  it("an entity the caller does not cover is still the 404 of a missing one", async () => {
    signIn([assign.domain("AUTHOR", T, "d-sales")]);
    expect((await get("customer")).status).toBe(404);
  });
});
