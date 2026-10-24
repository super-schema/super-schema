// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SchemasTab } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/SchemasTab";

// The toasts are what the user sees: record them.
const { toastMock } = vi.hoisted(() => ({ toastMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: toastMock }));

// Mock the actions
vi.mock(
  "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions",
  () => ({
    getSchemaVersionsAction: vi.fn(),
    generateSchemaAction: vi.fn(),
    saveSchemaFieldTypeOverrideAction: vi.fn(),
  })
);

// Stage Emit: the real dialog is a checklist; a stub that emits three targets at once keeps the test about the toast.
vi.mock("@/features/emission/StagedEmitDialog/StagedEmitDialog", async () => {
  const React = await import("react");
  return {
    StagedEmitDialog: ({ open, onEmitSelected }: { open: boolean; onEmitSelected: (targets: string[]) => void }) =>
      open ? React.createElement("button", { type: "button", onClick: () => onEmitSelected(["bigquery", "avro", "spanner"]) }, "Emit all three") : null,
  };
});

// Mock schema target catalog
vi.mock("@/lib/schema-targets/catalog", () => ({
  getSchemaTargetAvailabilities: () => [
    { target: { key: "bigquery" }, available: true },
    { target: { key: "avro" }, available: true },
    { target: { key: "spanner" }, available: true },
  ],
  getSchemaTargetDefinition: (key: string) => ({
    displayName: key === "bigquery" ? "BigQuery" : key === "avro" ? "Avro" : "Spanner",
    // Spanner is a target whose generation does not apply a stored override: it is not offered the Manual Override table.
    supportsFieldOverrides: key !== "spanner",
  }),
}));

const {
  getSchemaVersionsAction: getSchemaVersionsActionMock,
  generateSchemaAction: generateSchemaActionMock,
  saveSchemaFieldTypeOverrideAction: saveOverrideActionMock,
} = await import(
  "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions"
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

  afterEach(() => {
    cleanup();
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
      expect(screen.getByText("Manual Override")).toBeDefined();
    });
  });

  it("offers Manual Override only for a target whose generation applies overrides", async () => {
    (getSchemaVersionsActionMock as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, schemaVersions: {} });
    render(<SchemasTab {...baseProps} />);

    // BigQuery is selected first and applies overrides here.
    await waitFor(() => expect(screen.getAllByText("Manual Override").length).toBeGreaterThan(0));

    // Spanner does not: no tab, and the Generated Schema tab and the Mapping Matrix stay.
    screen.getByRole("button", { name: "Spanner" }).click();
    await waitFor(() => expect(screen.queryByText("Manual Override")).toBeNull());
    expect(screen.getByText("Generated Schema")).toBeDefined();
    expect(screen.getByText("Mapping Matrix")).toBeDefined();
  });

  it("leaves the Manual Override table for the schema when the selected target is changed to one that does not apply overrides", async () => {
    (getSchemaVersionsActionMock as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, schemaVersions: {} });
    render(<SchemasTab {...baseProps} />);
    (await screen.findAllByText("Manual Override"))[0].click();
    await waitFor(() => expect(screen.getByText("Super Schema Type")).toBeDefined());

    screen.getByRole("button", { name: "Spanner" }).click();

    await waitFor(() => expect(screen.queryByText("Super Schema Type")).toBeNull());
    expect(screen.getByText(/No schema generated yet/)).toBeDefined();
  });

  it("shows type override table with field list", async () => {
    (getSchemaVersionsActionMock as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      schemaVersions: {},
    });

    render(<SchemasTab {...baseProps} />);

    await waitFor(() => {
      expect(screen.getAllByText("Manual Override").length).toBeGreaterThan(0);
    });

    // Click Type Overrides tab (the button element)
    const overrideButtons = screen.getAllByText("Manual Override");
    overrideButtons[0].click();

    await waitFor(() => {
      expect(screen.getByText("Field")).toBeDefined();
      expect(screen.getByText("Super Schema Type")).toBeDefined();
    });
  });

  it("shows a cross-target mapping matrix with examples and risk badges", async () => {
    (getSchemaVersionsActionMock as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      schemaVersions: {},
    });

    render(
      <SchemasTab
        {...baseProps}
        fields={[
          { ...baseProps.fields[0], id: "amount", name: "amount", type: "decimal", precision: 19, scale: 4 },
          { ...baseProps.fields[1], id: "externalId", name: "externalId", type: "uint64", precision: null, scale: null },
        ]}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByText("Mapping Matrix").length).toBeGreaterThan(0);
    });

    screen.getAllByText("Mapping Matrix")[0].click();

    await waitFor(() => {
      expect(screen.getByText("amount")).toBeDefined();
      expect(screen.getByText("externalId")).toBeDefined();
    });
    expect(screen.getAllByText("INT64").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Range risk").length).toBeGreaterThan(0);
    expect(screen.getByText(/0 … 1\.8 × 10¹⁹/)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The toast after generating: the warnings must reach the user (nothing else shows them: the SchemaVersion stores none)
// ---------------------------------------------------------------------------

const schemaVersion = { version: 1, status: "draft", output: "CREATE TABLE customer (...)", generatedAt: "2026-04-07T10:00:00.000Z", entityVersion: 1 };
const ORDER_WARNING = 'The column "order" is a reserved word in BigQuery and the generated DDL does not quote it, so it will not run as is. Rename the field, or quote the name in the DDL by hand.';
const WARNING_OPTIONS = { duration: 10_000, classNames: { description: "whitespace-pre-line" } };

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const toastsShown = () => toastMock.success.mock.calls.length + toastMock.warning.mock.calls.length + toastMock.error.mock.calls.length;

describe("SchemasTab: the toast after Generate", () => {
  /** Render the tab, press Generate for the first target (BigQuery) and wait until a toast was shown. */
  async function generateWith(answer: Record<string, unknown>) {
    asMock(getSchemaVersionsActionMock).mockResolvedValue({ success: true, schemaVersions: {} });
    asMock(generateSchemaActionMock).mockResolvedValue(answer);
    render(<SchemasTab {...baseProps} />);
    (await screen.findByText("Generate")).click();
    await waitFor(() => expect(generateSchemaActionMock).toHaveBeenCalledWith("entity-1", "bigquery"));
    await waitFor(() => expect(toastsShown()).toBeGreaterThan(0));
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("a target generated with a warning shows ONE warning toast: the count as the title, the warning itself as the description", async () => {
    await generateWith({ success: true, schemaVersion, validationStatus: "WARNING", warnings: [ORDER_WARNING], errors: [] });

    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(toastMock.warning).toHaveBeenCalledWith("Generated with 1 warning.", { description: ORDER_WARNING, ...WARNING_OPTIONS });
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("two warnings are BOTH named (the second used to be lost) and nothing points at a preview", async () => {
    const group = ORDER_WARNING.replace('"order"', '"group"');
    await generateWith({ success: true, schemaVersion, validationStatus: "WARNING", warnings: [ORDER_WARNING, group], errors: [] });

    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(toastMock.warning).toHaveBeenCalledWith("Generated with 2 warnings.", { description: `${ORDER_WARNING}\n${group}`, ...WARNING_OPTIONS });
    expect(JSON.stringify(toastMock.warning.mock.calls)).not.toMatch(/preview/i);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("more than five warnings: five are listed, then '...and N-5 more.'", async () => {
    const warnings = Array.from({ length: 8 }, (_, i) => `warning ${i + 1}`);
    await generateWith({ success: true, schemaVersion, validationStatus: "WARNING", warnings, errors: [] });

    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(toastMock.warning).toHaveBeenCalledWith("Generated with 8 warnings.", {
      description: "warning 1\nwarning 2\nwarning 3\nwarning 4\nwarning 5\n...and 3 more.",
      ...WARNING_OPTIONS,
    });
  });

  it("a long warning is cut to 200 characters in the list", async () => {
    await generateWith({ success: true, schemaVersion, validationStatus: "WARNING", warnings: ["y".repeat(500)], errors: [] });

    expect(toastMock.warning).toHaveBeenCalledWith("Generated with 1 warning.", { description: `${"y".repeat(199)}…`, ...WARNING_OPTIONS });
  });

  it("no warnings: the usual success toast, no warning toast", async () => {
    await generateWith({ success: true, schemaVersion, validationStatus: "VALID", warnings: [], errors: [] });

    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledWith("BigQuery schema generated (Draft)");
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it("an answer without a warnings list is the usual success toast too", async () => {
    await generateWith({ success: true, schemaVersion });

    expect(toastMock.success).toHaveBeenCalledWith("BigQuery schema generated (Draft)");
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it("an error stays an error toast", async () => {
    await generateWith({ error: "@typespec/bigquery/missing-primary-key: Table 'Customer' must have at least one @primaryKey property." });

    expect(toastMock.error).toHaveBeenCalledWith("@typespec/bigquery/missing-primary-key: Table 'Customer' must have at least one @primaryKey property.");
    expect(toastMock.warning).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});

describe("SchemasTab: Stage Emit shows one toast for the whole run", () => {
  /** Open Stage Emit, emit bigquery + avro + spanner (the stub dialog) with the given answer per target. */
  async function stageEmit(answers: Record<string, Record<string, unknown>>) {
    asMock(getSchemaVersionsActionMock).mockResolvedValue({ success: true, schemaVersions: {} });
    asMock(generateSchemaActionMock).mockImplementation(async (_entityId: string, target: string) => answers[target]);
    render(<SchemasTab {...baseProps} />);
    (await screen.findByText("Stage Emit")).click();
    (await screen.findByText("Emit all three")).click();
    await waitFor(() => expect(generateSchemaActionMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(toastsShown()).toBeGreaterThan(0));
  }
  const clean = { success: true, schemaVersion, validationStatus: "VALID", warnings: [], errors: [] };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("a warning on one of three targets: ONE warning toast titled with the schema and warning counts, the warning prefixed with its target", async () => {
    await stageEmit({ bigquery: { ...clean, validationStatus: "WARNING", warnings: [ORDER_WARNING] }, avro: clean, spanner: clean });

    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(toastMock.warning).toHaveBeenCalledWith("Generated 3 schemas with 1 warning.", { description: `BigQuery: ${ORDER_WARNING}`, ...WARNING_OPTIONS });
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("warnings on several targets are listed with their targets, five at most, then '...and N-5 more.'", async () => {
    const four = Array.from({ length: 4 }, (_, i) => `bq ${i + 1}`);
    await stageEmit({ bigquery: { ...clean, warnings: four }, avro: clean, spanner: { ...clean, warnings: ["sp 1", "sp 2", "sp 3"] } });

    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(toastMock.warning).toHaveBeenCalledWith("Generated 3 schemas with 7 warnings.", {
      description: "BigQuery: bq 1\nBigQuery: bq 2\nBigQuery: bq 3\nBigQuery: bq 4\nSpanner: sp 1\n...and 2 more.",
      ...WARNING_OPTIONS,
    });
  });

  it("no warnings anywhere: the usual success text", async () => {
    await stageEmit({ bigquery: clean, avro: clean, spanner: clean });

    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledWith("Generated 3 schemas (Draft)");
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it("a failed target stays its own error toast; the schemas that were generated are counted", async () => {
    await stageEmit({ bigquery: { error: "no key" }, avro: clean, spanner: { ...clean, warnings: ["sp 1"] } });

    expect(toastMock.error).toHaveBeenCalledWith("BigQuery: no key");
    expect(toastMock.warning).toHaveBeenCalledWith("Generated 2 schemas with 1 warning.", { description: "Spanner: sp 1", ...WARNING_OPTIONS });
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});

describe("SchemasTab: applying a type override regenerates the schema and shows its warnings the same way", () => {
  /** Open Manual Override, open the first field's type picker, choose its first option. */
  async function applyOverride(answer: Record<string, unknown>) {
    asMock(getSchemaVersionsActionMock).mockResolvedValue({ success: true, schemaVersions: {} });
    asMock(saveOverrideActionMock).mockResolvedValue(answer);
    render(<SchemasTab {...baseProps} />);
    (await screen.findAllByText("Manual Override"))[0].click();
    await waitFor(() => expect(document.querySelectorAll('button[aria-haspopup="listbox"]').length).toBeGreaterThan(0));
    (document.querySelectorAll('button[aria-haspopup="listbox"]')[0] as HTMLButtonElement).click();
    (await screen.findAllByRole("option"))[0].click();
    await waitFor(() => expect(saveOverrideActionMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastsShown()).toBeGreaterThan(0));
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("a regeneration with warnings shows the warning toast instead of 'Override applied'", async () => {
    await applyOverride({ success: true, schemaVersion, warnings: [ORDER_WARNING, "second"] });

    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(toastMock.warning).toHaveBeenCalledWith("Generated with 2 warnings.", { description: `${ORDER_WARNING}\nsecond`, ...WARNING_OPTIONS });
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("no warnings: the usual 'Override applied' toast", async () => {
    await applyOverride({ success: true, schemaVersion, warnings: [] });

    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledWith("Override applied — schema regenerated");
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it("an error stays an error toast", async () => {
    await applyOverride({ error: "Invalid BigQuery DDL target type" });

    expect(toastMock.error).toHaveBeenCalledWith("Invalid BigQuery DDL target type");
    expect(toastMock.warning).not.toHaveBeenCalled();
  });
});

