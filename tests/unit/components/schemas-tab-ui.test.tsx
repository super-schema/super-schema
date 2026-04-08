// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SchemasTab } from "@/app/(dashboard)/schemas/[domainSlug]/[entityId]/components/SchemasTab";

// Mock the actions
vi.mock(
  "@/app/(dashboard)/schemas/[domainSlug]/[entityId]/actions",
  () => ({
    getSchemaVersionsAction: vi.fn(),
    generateSchemaAction: vi.fn(),
  })
);

// Mock schema target catalog
vi.mock("@/lib/schema-targets/catalog", () => ({
  getSchemaTargetAvailabilities: () => [
    { target: { key: "bigquery" }, available: true },
    { target: { key: "avro" }, available: true },
    { target: { key: "spanner" }, available: true },
  ],
  getSchemaTargetDefinition: (key: string) => ({
    displayName: key === "bigquery" ? "BigQuery" : key === "avro" ? "Avro" : "Spanner",
    supportsFieldOverrides: true,
  }),
}));

const { getSchemaVersionsAction: getSchemaVersionsActionMock } = await import(
  "@/app/(dashboard)/schemas/[domainSlug]/[entityId]/actions"
);

const baseProps = {
  entityId: "entity-1",
  entityName: "Customer",
  fields: [
    { id: "f1", name: "id", type: "string", precision: null, scale: null, nullable: false, isKey: true, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0 },
    { id: "f2", name: "name", type: "string", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 1 },
  ],
  entity: { id: "entity-1", name: "Customer", slug: "customer", domainSlug: "playground", version: 1, metadata: null },
};

describe("SchemasTab UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders vertical technology tabs", async () => {
    (getSchemaVersionsActionMock as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      schemaVersions: {},
    });

    render(<SchemasTab {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("schemas-tab")).toBeDefined();
    });

    // Should show technology names as vertical tabs
    expect(screen.getByText("BigQuery")).toBeDefined();
    expect(screen.getByText("Avro")).toBeDefined();
    expect(screen.getByText("Spanner")).toBeDefined();
  });

  it("shows Generated Schema and Type Overrides horizontal tabs", async () => {
    (getSchemaVersionsActionMock as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      schemaVersions: {
        bigquery: [{ version: 1, status: "draft", output: "CREATE TABLE customer (...)", generatedAt: "2026-04-07T10:00:00.000Z", entityVersion: 1 }],
      },
    });

    render(<SchemasTab {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText("Generated Schema")).toBeDefined();
      expect(screen.getByText("Target Type Overrides")).toBeDefined();
    });
  });

  it("shows type override table with field list", async () => {
    (getSchemaVersionsActionMock as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      schemaVersions: {},
    });

    render(<SchemasTab {...baseProps} />);

    await waitFor(() => {
      expect(screen.getAllByText("Target Type Overrides").length).toBeGreaterThan(0);
    });

    // Click Type Overrides tab (the button element)
    const overrideButtons = screen.getAllByText("Target Type Overrides");
    overrideButtons[0].click();

    await waitFor(() => {
      expect(screen.getByText("Field")).toBeDefined();
      expect(screen.getByText("Super Schema Type")).toBeDefined();
    });
  });
});
