/**
 * The Schemas tab with multi-entity emission: a version's files as a list, the Preview badge naming the DRAFT references, the version each
 * reference used, old versions (no `files` / `resolution`) rendering exactly as before, and the reference pick dialog (generate and publish).
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SchemasTab } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/SchemasTab";

const { toastMock } = vi.hoisted(() => ({ toastMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({
  getSchemaVersionsAction: vi.fn(),
  generateSchemaAction: vi.fn(),
  publishSchemaAction: vi.fn(),
  setEntityPrimaryKeyAction: vi.fn(),
  setFieldReferenceAction: vi.fn(),
  saveSchemaFieldTypeOverrideAction: vi.fn(),
}));

vi.mock("@/features/emission/StagedEmitDialog/StagedEmitDialog", () => ({ StagedEmitDialog: () => null }));

vi.mock("@/lib/schema-targets/catalog", () => ({
  getSchemaTargetAvailabilities: () => [
    { target: { key: "json-schema" }, available: true },
    { target: { key: "bigquery" }, available: true },
  ],
  getSchemaTargetDefinition: (key: string) => ({ displayName: key === "json-schema" ? "JSON Schema" : "BigQuery", supportsFieldOverrides: false }),
}));

const actions = await import("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions");
const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const getVersions = asMock(actions.getSchemaVersionsAction);
const generate = asMock(actions.generateSchemaAction);
const publish = asMock(actions.publishSchemaAction);
const setReference = asMock(actions.setFieldReferenceAction);

const baseProps = {
  entityId: "entity-1",
  entityName: "Customer",
  fields: [
    { id: "f1", name: "id", type: "string", precision: null, scale: null, nullable: false, isKey: true, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0 },
  ],
  entity: { id: "entity-1", name: "Customer", slug: "customer", domainSlug: "sales", version: 1, metadata: null },
};

const ROOT = { entityId: "entity-1", domain: "Sales", product: "Crm", entity: "Customer" };
const ADDRESS = { entityId: "entity-2", domain: "Billing", product: "Core", entity: "Address" };
const MONEY = { entityId: "entity-3", domain: "Billing", product: "Core", entity: "Money" };

const FILES = [
  { path: "Billing/Core/Address.json", content: '{ "title": "Address-body" }', target: "json-schema", entityId: "entity-2" },
  { path: "Sales/Crm/Customer.json", content: '{ "title": "Customer-body" }', target: "json-schema", entityId: "entity-1" },
];

function closureVersion(entities: Array<{ ref: typeof ROOT; source: "published" | "draft" | "pinned"; version?: string }>, over: Record<string, unknown> = {}) {
  return {
    version: 1,
    status: "draft",
    output: "===== bundled =====",
    generatedAt: "2026-10-23T10:00:00.000Z",
    entityVersion: 1,
    files: FILES,
    resolution: { mode: "draft", preview: true, entities },
    ...over,
  };
}

async function showVersions(versions: unknown[]) {
  getVersions.mockResolvedValue({ success: true, schemaVersions: { "json-schema": versions } });
  render(<SchemasTab {...baseProps} />);
  await screen.findByTestId("schemas-tab");
  await screen.findByText("Generated Schema");
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
});
afterEach(cleanup);

const codeText = () => screen.getByTestId("schema-code-preview").textContent ?? "";

describe("SchemasTab: the files of a closure version", () => {
  it("lists the files, shows one in the code preview and switches when another is picked", async () => {
    await showVersions([closureVersion([{ ref: ROOT, source: "draft" }, { ref: ADDRESS, source: "published", version: "1.0" }])]);

    const paths = screen.getAllByTestId("schema-file-item").map((el) => el.getAttribute("data-path"));
    // the root's file is listed (and shown) first
    expect(paths).toEqual(["Sales/Crm/Customer.json", "Billing/Core/Address.json"]);
    expect(codeText()).toContain("Customer-body");

    fireEvent.click(screen.getAllByTestId("schema-file-item")[1]);

    expect(codeText()).toContain("Address-body");
    expect(codeText()).not.toContain("Customer-body");
    expect(screen.getByTestId("schema-file-set-download-all")).toBeDefined();
  });

  it("shows a version stored before multi-entity emission (no files, no resolution) as the single code preview of its output", async () => {
    await showVersions([{ version: 1, status: "draft", output: '{ "legacy": true }', generatedAt: "2026-04-07T10:00:00.000Z", entityVersion: 1 }]);

    expect(codeText()).toContain('"legacy": true');
    expect(screen.queryByTestId("schema-file-set")).toBeNull();
    expect(screen.queryByTestId("schema-file-set-list")).toBeNull();
    expect(screen.queryByTestId("schema-preview-badge")).toBeNull();
    expect(screen.queryByTestId("schema-reference-versions")).toBeNull();
    // the preview keeps its own caption, not a file path
    expect(within(screen.getByTestId("schema-code-preview")).getByText("Preview")).toBeDefined();
  });

  it("shows a stand-alone version (one file, no references) as the single code preview of its output", async () => {
    await showVersions([
      closureVersion([{ ref: ROOT, source: "draft" }], { output: '{ "title": "alone" }', files: [{ path: "Sales/Crm/Customer.json", content: '{ "title": "alone" }', target: "json-schema", entityId: "entity-1" }] }),
    ]);

    expect(codeText()).toContain('"title": "alone"');
    expect(screen.queryByTestId("schema-file-set-list")).toBeNull();
    expect(within(screen.getByTestId("schema-code-preview")).getByText("Preview")).toBeDefined();
  });
});

describe("SchemasTab: the Preview badge and the versions the references used", () => {
  it("marks a version that used the saved draft of a REFERENCED entity, listing it as domain / product / entity", async () => {
    await showVersions([
      closureVersion([{ ref: ROOT, source: "draft" }, { ref: ADDRESS, source: "draft" }, { ref: MONEY, source: "published", version: "2.1" }]),
    ]);

    expect(screen.getByTestId("schema-preview-badge").textContent).toContain("Preview (drafts used)");
    const drafts = within(screen.getByTestId("schema-draft-reference-list")).getAllByTestId("schema-draft-reference");
    expect(drafts.map((el) => el.textContent)).toEqual(["Billing / Core / Address"]);
  });

  it("does not mark a version whose only draft entity is the root itself (resolution.preview counts the root)", async () => {
    await showVersions([closureVersion([{ ref: ROOT, source: "draft" }, { ref: ADDRESS, source: "published", version: "1.0" }])]);

    expect(screen.queryByTestId("schema-preview-badge")).toBeNull();
    expect(screen.queryByTestId("schema-draft-reference-list")).toBeNull();
  });

  it("does not mark a version generated from the published versions", async () => {
    await showVersions([
      closureVersion([{ ref: ROOT, source: "published", version: "1.0" }, { ref: ADDRESS, source: "published", version: "1.0" }], {
        resolution: { mode: "published", preview: false, entities: [{ ref: ROOT, source: "published", version: "1.0" }, { ref: ADDRESS, source: "published", version: "1.0" }] },
      }),
    ]);

    expect(screen.queryByTestId("schema-preview-badge")).toBeNull();
  });

  it("shows the version each reference used: pinned, latest published, or draft", async () => {
    await showVersions([
      closureVersion([
        { ref: ROOT, source: "draft" },
        { ref: ADDRESS, source: "pinned", version: "1.2" },
        { ref: MONEY, source: "published", version: "2.1" },
        { ref: { entityId: "entity-4", domain: "Billing", product: "Core", entity: "Tax" }, source: "draft" },
      ]),
    ]);

    const rows = within(screen.getByTestId("schema-reference-versions")).getAllByTestId("schema-reference-version");
    expect(rows.map((row) => row.getAttribute("data-source"))).toEqual(["pinned", "published", "draft"]);
    expect(rows[0].textContent).toMatch(/Billing \/ Core \/ Address.*v1\.2.*pinned/);
    expect(rows[1].textContent).toMatch(/Billing \/ Core \/ Money.*v2\.1.*latest published/);
    expect(rows[2].textContent).toMatch(/Billing \/ Core \/ Tax.*draft/);
    expect(rows[2].textContent).not.toMatch(/\bv\d/);
  });

  it("lists nothing about references for an entity that references none", async () => {
    await showVersions([closureVersion([{ ref: ROOT, source: "draft" }])]);
    expect(screen.queryByTestId("schema-reference-versions")).toBeNull();
  });

  it("follows the version being viewed", async () => {
    await showVersions([
      closureVersion([{ ref: ROOT, source: "draft" }, { ref: ADDRESS, source: "draft" }], { version: 2 }),
      closureVersion([{ ref: ROOT, source: "published", version: "1.0" }, { ref: ADDRESS, source: "published", version: "1.0" }], {
        version: 1,
        resolution: { mode: "published", preview: false, entities: [{ ref: ROOT, source: "published", version: "1.0" }, { ref: ADDRESS, source: "published", version: "1.0" }] },
      }),
    ]);
    expect(screen.getByTestId("schema-preview-badge")).toBeDefined();

    fireEvent.click(screen.getByText("v1").closest("button") as HTMLButtonElement);

    expect(screen.queryByTestId("schema-preview-badge")).toBeNull();
  });
});
