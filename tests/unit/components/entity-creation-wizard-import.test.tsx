/**
 * EntityCreationWizard — import routing (Epic 15.5 / 15.6).
 *
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
// The visual builder hands its output over with the format it was built in.
vi.mock("@/components/custom/VisualSchemaBuilder/VisualSchemaBuilder", () => ({
  VisualSchemaBuilder: ({ onImport }: { onImport: (content: string, format: string) => void }) => (
    <button
      type="button"
      onClick={() => onImport('syntax = "proto3";\nmessage Visual { string id = 1; }', "protobuf")}
    >
      Use builder output
    </button>
  ),
}));
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

function pasteAndParse(content: string) {
  fireEvent.click(screen.getByRole("button", { name: /Import Schema/ }));
  fireEvent.change(screen.getByPlaceholderText(/Paste your schema content here/), {
    target: { value: content },
  });
  fireEvent.click(screen.getByRole("button", { name: /Parse Schema/ }));
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
    pasteAndParse(ORDER_PROTO);

    await waitFor(() => expect(screen.getByTestId("typespec-import-review")).toBeDefined());
    expect(screen.getByText("Review Protobuf Import")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Import \d+ Asset\(s\)/ }));
    await waitFor(() => expect(mocks.createDomainAssetsFromImportAction).toHaveBeenCalledTimes(1));
    const payload = mocks.createDomainAssetsFromImportAction.mock.calls[0][0];
    expect(payload).toMatchObject({ domainId: "dom-1", productId: "prod-1" });
    expect(payload.entities).toHaveLength(4);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/schemas/payments/checkout"));
  });

  it("keeps a single-message proto on the field preview", async () => {
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    pasteAndParse(`syntax = "proto3";\nmessage User { string id = 1; }`);

    await waitFor(() => expect(screen.getByDisplayValue("User")).toBeDefined());
    expect(screen.queryByTestId("typespec-import-review")).toBeNull();
  });

  it("persists imported field numbers and map/oneof metadata from the single-entity preview", async () => {
    mocks.createEntityWithFieldsAction.mockResolvedValue({ success: true, entityId: "e1" });
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    pasteAndParse(
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

  it("explains that multi-entity imports go into a product at the Enterprise level", async () => {
    render(<EntityCreationWizard target={{ level: "TENANT", tenantId: "tenant-1" }} />);
    pasteAndParse(ORDER_PROTO);

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
    fireEvent.click(screen.getByRole("button", { name: /Build Visually/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use builder output" }));

    await waitFor(() => expect(screen.getByDisplayValue("Visual")).toBeDefined());
    expect(importSchemaAssets).toHaveBeenCalledWith(
      'syntax = "proto3";\nmessage Visual { string id = 1; }',
      "protobuf"
    );
  });

  it("passes the uploader's detected format for pasted content", async () => {
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    pasteAndParse(`syntax = "proto3";\nmessage User { string id = 1; }`);

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
    pasteAndParse(`openapi: "3.0.0"\ninfo:\n  title: Pets\n  version: "1"\npaths:\n  /pets: {}\n`);

    await waitFor(() => expect(screen.getByText("Review OpenAPI Import")).toBeDefined());
    expect(mocks.importOpenApiDocumentAction).toHaveBeenCalledTimes(1);
  });
});
