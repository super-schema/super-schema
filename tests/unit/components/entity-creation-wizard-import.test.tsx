/**
 * EntityCreationWizard — import routing (Epic 15.5 / 15.6).
 *
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EntityCreationWizard } from "@/components/custom/EntityCreationWizard/EntityCreationWizard";
import { importSchemaAssets } from "@/services/import.service";
import { detectFormat } from "@/lib/importers/format-detector";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  invalidate: vi.fn(),
  createEntityWithFieldsAction: vi.fn(),
  createDomainAssetsFromImportAction: vi.fn(),
  createTenantEntityAction: vi.fn(),
  importOpenApiDocumentAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({
  createEntityWithFieldsAction: mocks.createEntityWithFieldsAction,
  createDomainAssetsFromImportAction: mocks.createDomainAssetsFromImportAction,
}));
vi.mock("@/app/(dashboard)/schemas/enterprise/actions", () => ({
  createTenantEntityAction: mocks.createTenantEntityAction,
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/typespec-import-actions", () => ({
  importTypeSpecDocumentAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/openapi-import-actions", () => ({
  importOpenApiDocumentAction: mocks.importOpenApiDocumentAction,
}));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => mocks.invalidate }));
// Real import service, observed: the wizard must hand over the builder's format.
vi.mock("@/services/import.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/import.service")>();
  return { ...actual, importSchemaAssets: vi.fn(actual.importSchemaAssets) };
});
// Real detector by default; one test makes detection disagree with the builder.
vi.mock("@/lib/importers/format-detector", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/importers/format-detector")>();
  return { ...actual, detectFormat: vi.fn(actual.detectFormat) };
});
vi.mock("@/components/custom/TypePicker", () => ({ TypePicker: () => <select /> }));
vi.mock("@/components/custom/ClassificationPicker", () => ({ ClassificationPicker: () => null }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const PRODUCT_TARGET = {
  level: "PRODUCT" as const,
  productId: "prod-1",
  domainId: "dom-1",
  domainName: "Payments",
  domainSlug: "payments",
  productSlug: "checkout",
};

const ORDER_PROTO = readFileSync(
  path.resolve(process.cwd(), "tests/fixtures/importers/order.proto"),
  "utf8"
);

async function pasteAndParse(content: string) {
  fireEvent.click(screen.getByRole("button", { name: /Import or Build Schema/ }));
  fireEvent.click(screen.getByRole("button", { name: "Paste" }));
  fireEvent.change(screen.getByTestId("workbench-paste-textarea"), {
    target: { value: content },
  });
  fireEvent.click(screen.getByTestId("workbench-load-button"));
  await waitFor(() =>
    expect((screen.getByTestId("detail-panel-textarea") as HTMLTextAreaElement).value).toBe(content)
  );
  fireEvent.click(screen.getByTestId("workbench-review-button"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createDomainAssetsFromImportAction.mockResolvedValue({
    modelsCreated: 4,
    entitiesCreated: 4,
    enumsCreated: 2,
    scalarsCreated: 0,
    unionsCreated: 0,
    servicesCreated: 0,
    decoratorsCreated: 0,
    entityIds: [],
    modelIds: [],
    errors: [],
  });
});

afterEach(cleanup);

describe("EntityCreationWizard — multi-entity import", () => {
  it("sends a multi-message proto through the multi-asset review and persists it in the product", async () => {
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    await pasteAndParse(ORDER_PROTO);

    await waitFor(() => expect(screen.getByTestId("typespec-import-review")).toBeDefined());
    expect(screen.getByText("Review Protobuf Import")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Import \d+ Asset\(s\)/ }));
    await waitFor(() => expect(mocks.createDomainAssetsFromImportAction).toHaveBeenCalledTimes(1));
    const payload = mocks.createDomainAssetsFromImportAction.mock.calls[0][0];
    expect(payload).toMatchObject({ domainId: "dom-1", productId: "prod-1" });
    expect(payload.entities).toHaveLength(4);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/schemas/payments/checkout"));
    // The explorer's cached tree only refreshes through invalidate: the new entities must show up without a reload.
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });

  it("does not refresh the explorer when the import created nothing", async () => {
    mocks.createDomainAssetsFromImportAction.mockResolvedValue({
      modelsCreated: 0, entitiesCreated: 0, enumsCreated: 0, scalarsCreated: 0, unionsCreated: 0,
      servicesCreated: 0, decoratorsCreated: 0, entityIds: [], modelIds: [], errors: ["Could not create Order"],
    });
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    await pasteAndParse(ORDER_PROTO);
    await waitFor(() => expect(screen.getByTestId("typespec-import-review")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /Import \d+ Asset\(s\)/ }));
    await waitFor(() => expect(mocks.createDomainAssetsFromImportAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: /Import \d+ Asset\(s\)/ })).toBeDefined());
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("keeps a single-message proto on the field preview", async () => {
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    await pasteAndParse(`syntax = "proto3";\nmessage User { string id = 1; }`);

    await waitFor(() => expect(screen.getByDisplayValue("User")).toBeDefined());
    expect(screen.queryByTestId("typespec-import-review")).toBeNull();
  });

  it("persists imported field numbers and map/oneof metadata from the single-entity preview", async () => {
    mocks.createEntityWithFieldsAction.mockResolvedValue({ success: true, entityId: "e1" });
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    await pasteAndParse(
      `syntax = "proto3";\nmessage User {\n  map<string, int64> scores = 4;\n  oneof contact { string email = 7; }\n}`
    );
    await waitFor(() => expect(screen.getByDisplayValue("User")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Create Entity" }));

    await waitFor(() => expect(mocks.createEntityWithFieldsAction).toHaveBeenCalledTimes(1));
    const [, input] = mocks.createEntityWithFieldsAction.mock.calls[0];
    const [scores, email] = input.fields;
    expect(scores).toMatchObject({
      name: "scores",
      fieldNumber: 4,
      decorators: { mapKeyType: "string", mapValueType: "int64" },
    });
    expect(email).toMatchObject({
      fieldNumber: 7,
      decorators: { governance: { protobufFieldNumber: 7, protobufOneofGroup: "contact" } },
    });
  });

  it("keeps the precision and scale of an imported decimal (BigQuery NUMERIC(12, 2)) in the create call, and shows them in the review row", async () => {
    mocks.createEntityWithFieldsAction.mockResolvedValue({ success: true, entityId: "e-dec" });
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    await pasteAndParse("CREATE TABLE ledger (\n  id STRING NOT NULL,\n  total NUMERIC(12, 2),\n  fee NUMERIC\n);");
    await waitFor(() => expect(screen.getByDisplayValue("ledger")).toBeDefined());
    // The review row of the decimal says what the source declared; a plain NUMERIC says nothing of the kind.
    expect(screen.getByText("(12,2)")).toBeDefined();
    expect(screen.getAllByText(/^\(\d+,\d+\)$/)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Create Entity" }));

    await waitFor(() => expect(mocks.createEntityWithFieldsAction).toHaveBeenCalledTimes(1));
    const [, input] = mocks.createEntityWithFieldsAction.mock.calls[0];
    const [id, total, fee] = input.fields;
    expect(id).toMatchObject({ name: "id", precision: null, scale: null });
    expect(total).toMatchObject({ name: "total", type: "decimal", precision: 12, scale: 2 });
    expect(fee).toMatchObject({ name: "fee", type: "decimal", precision: null, scale: null });
  });

  it("opens the NEW entity page after a single-entity import creates it (not the product page)", async () => {
    mocks.createEntityWithFieldsAction.mockResolvedValue({ success: true, entityId: "e-new" });
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    await pasteAndParse(`syntax = "proto3";\nmessage User { string id = 1; }`);
    await waitFor(() => expect(screen.getByDisplayValue("User")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Create Entity" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/schemas/payments/checkout/e-new"));
  });

  it("carries the entity-level vendor extensions of a single JSON Schema into the create call", async () => {
    mocks.createEntityWithFieldsAction.mockResolvedValue({ success: true, entityId: "e-ext" });
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    await pasteAndParse(
      JSON.stringify({ title: "Device", type: "object", "x-team": "iot", properties: { id: { type: "string" } } })
    );
    await waitFor(() => expect(screen.getByDisplayValue("Device")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Create Entity" }));

    await waitFor(() => expect(mocks.createEntityWithFieldsAction).toHaveBeenCalledTimes(1));
    const [, input] = mocks.createEntityWithFieldsAction.mock.calls[0];
    expect(input.extensions).toEqual({ "x-team": "iot" });
  });

  it("explains that multi-entity imports go into a product at the Enterprise level", async () => {
    render(<EntityCreationWizard target={{ level: "TENANT", tenantId: "tenant-1" }} />);
    await pasteAndParse(ORDER_PROTO);

    expect(
      await screen.findByText(
        /^Multi-entity imports go into a product — at Enterprise level an import creates one entity\./
      )
    ).toBeDefined();
    expect(screen.getByText(/defines 6 assets/)).toBeDefined();
    expect(screen.queryByTestId("typespec-import-review")).toBeNull();
  });
});

describe("EntityCreationWizard — visual builder hand-off (Story 15.6)", () => {
  afterEach(async () => {
    const actual = await vi.importActual<typeof import("@/lib/importers/format-detector")>(
      "@/lib/importers/format-detector"
    );
    vi.mocked(detectFormat).mockImplementation(actual.detectFormat);
  });

  it("uses the builder's format instead of re-detecting it", async () => {
    // Detection disagrees with the builder: the builder's format must win.
    vi.mocked(detectFormat).mockImplementation(() => "avro");
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    fireEvent.click(screen.getByRole("button", { name: /Import or Build Schema/ }));
    fireEvent.click(screen.getByRole("button", { name: "Build form" }));
    fireEvent.click(screen.getByRole("button", { name: "Protobuf" }));
    fireEvent.change(screen.getByDisplayValue("NewEntity"), { target: { value: "Visual" } });
    fireEvent.change(screen.getByPlaceholderText("field_name"), { target: { value: "id" } });
    fireEvent.click(screen.getByTestId("workbench-review-button"));

    await waitFor(() => expect(screen.getByDisplayValue("Visual")).toBeDefined());
    expect(importSchemaAssets).toHaveBeenCalledWith(
      expect.stringContaining("message Visual {"),
      "protobuf"
    );
  });

  it("passes the detected format for pasted content", async () => {
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    await pasteAndParse(`syntax = "proto3";\nmessage User { string id = 1; }`);

    await waitFor(() => expect(screen.getByDisplayValue("User")).toBeDefined());
    expect(importSchemaAssets).toHaveBeenLastCalledWith(expect.any(String), "protobuf");
  });

  it("routes an OpenAPI document (now accepted as .json/.yaml) through the OpenAPI action", async () => {
    mocks.importOpenApiDocumentAction.mockResolvedValue({
      success: true,
      data: {
        sourceFormat: "openapi",
        models: [],
        sharedEnums: [{ name: "PetKind", values: ["DOG", "CAT"] }],
        customScalars: [],
        unions: [],
        aliases: [],
        decoratorDefinitions: [],
        services: [],
        warnings: [],
      },
    });
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    await pasteAndParse(`openapi: "3.0.0"\ninfo:\n  title: Pets\n  version: "1"\npaths:\n  /pets: {}\n`);

    await waitFor(() => expect(screen.getByText("Review OpenAPI Import")).toBeDefined());
    expect(mocks.importOpenApiDocumentAction).toHaveBeenCalledTimes(1);
  });
});

describe("EntityCreationWizard: single JSON Schema import keeps everything the importer found", () => {
  const SINGLE = JSON.stringify({
    type: "object",
    required: ["id", "ssn"],
    not: { type: "null" },
    properties: {
      id: { type: "string" },
      ssn: {
        type: "string",
        multipleOf: 2,
        "x-securityClassification": { data_class: "PII", data_category: "identity" },
      },
      note: { type: "string", "x-audit": { by: "bob" } },
    },
  });

  it("passes the imported nullable / isKey / classification to the created field input", async () => {
    mocks.createEntityWithFieldsAction.mockResolvedValue({ success: true, entityId: "e1" });
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    await pasteAndParse(SINGLE);
    await waitFor(() => expect(screen.getByDisplayValue("ImportedEntity")).toBeDefined());

    fireEvent.change(screen.getByDisplayValue("ImportedEntity"), { target: { value: "Person" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Entity" }));

    await waitFor(() => expect(mocks.createEntityWithFieldsAction).toHaveBeenCalledTimes(1));
    const [, input] = mocks.createEntityWithFieldsAction.mock.calls[0];
    const byName = Object.fromEntries(input.fields.map((f: { name: string }) => [f.name, f]));
    expect(byName.id).toMatchObject({ nullable: false, isKey: true, classification: null });
    expect(byName.ssn).toMatchObject({ nullable: false, isKey: false, classification: "PII" });
    expect(byName.note).toMatchObject({ nullable: true, isKey: false });
  });

  it("shows every warning, the entity's ignored keywords and each field's details in the preview", async () => {
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    await pasteAndParse(SINGLE);
    await waitFor(() => expect(screen.getByDisplayValue("ImportedEntity")).toBeDefined());

    expect(screen.getByText("Entity `ImportedEntity`: JSON Schema keyword `not` is not supported and was ignored")).toBeDefined();
    expect(screen.getByText("Field `ImportedEntity.ssn`: JSON Schema keyword `multipleOf` is not supported and was ignored")).toBeDefined();
    const ssn = within(screen.getByTestId("parsed-field-details-ssn"));
    expect(ssn.getByText("identity")).toBeDefined();
    // listed as not used AND kept under Preserved
    expect(within(ssn.getByTestId("parsed-field-ignored")).getByText("multipleOf")).toBeDefined();
    expect(within(ssn.getByTestId("parsed-field-preserved")).getByText("multipleOf")).toBeDefined();
    expect(within(screen.getByTestId("parsed-field-details-note")).getByText("x-audit")).toBeDefined();
  });

  it("highlights the entity name as needing a name when the importer fell back to its placeholder", async () => {
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    await pasteAndParse(SINGLE);
    const input = await screen.findByDisplayValue("ImportedEntity");
    expect(input.getAttribute("data-needs-name")).toBe("true");
    expect(screen.getByTestId("needs-name-hint").textContent).toContain("Give this entity a name");
    const create = screen.getByRole("button", { name: "Create Entity" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(create);
    expect(mocks.createEntityWithFieldsAction).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "  " } });
    expect(create.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "Person" } });
    expect(screen.queryByTestId("needs-name-hint")).toBeNull();
    expect(create.disabled).toBe(false);
  });

  it("does not flag a schema that names itself", async () => {
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    await pasteAndParse(JSON.stringify({ title: "Person", type: "object", properties: { id: { type: "string" } } }));
    await screen.findByDisplayValue("Person");
    expect(screen.queryByTestId("needs-name-hint")).toBeNull();
  });
});
