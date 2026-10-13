/**
 * ImportDialog — TypeSpec upload → review → confirm wiring.
 *
 * Parsing now happens in a server action backed by @typespec/compiler
 * (covered by tests/unit/lib/compiler/*). Here we mock the action with a
 * fixture result and verify the dialog's review → persist wiring.
 *
 * @vitest-environment jsdom
 */

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TypeSpecImportResult } from "@/lib/importers/typespec.importer";

const { createDomainAssetsFromImportActionMock, importTypeSpecDocumentActionMock } = vi.hoisted(
  () => ({
    createDomainAssetsFromImportActionMock: vi.fn(),
    importTypeSpecDocumentActionMock: vi.fn(),
  })
);

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, className }: { children: ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    className,
    type,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    className?: string;
    type?: "button" | "submit" | "reset";
  }) => (
    <button type={type} onClick={onClick} disabled={disabled} className={className}>
      {children}
    </button>
  ),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/typespec-import-actions", () => ({
  importTypeSpecDocumentAction: importTypeSpecDocumentActionMock,
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({
  createDomainAssetsFromImportAction: createDomainAssetsFromImportActionMock,
}));

import { ImportDialog } from "@/components/custom/ImportDialog";

function fixtureResult(): TypeSpecImportResult {
  return {
    models: [
      {
        name: "Customer",
        description: "A customer",
        fields: [
          { name: "id", type: "string", nullable: false, confidence: "high", originalType: "string", isKey: true },
          { name: "email", type: "string", nullable: false, confidence: "high", originalType: "string", format: "email" },
        ],
        sourceFormat: "typespec",
        originalContent: "",
        referencedModelNames: [],
        referencedByModelNames: [],
        recommendedAsEntity: true,
      },
    ],
    sharedEnums: [{ name: "Status", values: ["Active", "Inactive"] }],
    customScalars: [],
    unions: [],
    aliases: [],
    decoratorDefinitions: [],
    services: [],
    namespace: "MyApp",
    warnings: [],
  };
}

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

async function uploadTsp(container: HTMLElement) {
  fireEvent.click(screen.getByRole("button", { name: "Upload File" }));
  const input = container.querySelector(
    '[data-testid="drop-zone-single"] input[type="file"]'
  ) as HTMLInputElement | null;
  expect(input).toBeTruthy();
  const file = new File(["model Customer { id: string; }"], "customer.tsp", { type: "text/plain" });
  fireEvent.change(input!, { target: { files: [file] } });
}

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe("ImportDialog — TypeSpec upload wiring", () => {
  it("routes an uploaded .tsp through the compiler action to the review screen", async () => {
    importTypeSpecDocumentActionMock.mockResolvedValue({ success: true, data: fixtureResult() });

    const { container } = renderWithQueryClient(
      <ImportDialog isOpen onClose={vi.fn()} domains={[{ id: "domain-1", name: "Domain" }]} />
    );

    await uploadTsp(container);

    await waitFor(() => expect(screen.getByTestId("typespec-import-review")).toBeDefined());
    expect(importTypeSpecDocumentActionMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Customer")).toBeDefined();
  });

  it("confirms the import via createDomainAssetsFromImportAction", async () => {
    importTypeSpecDocumentActionMock.mockResolvedValue({ success: true, data: fixtureResult() });
    createDomainAssetsFromImportActionMock.mockResolvedValue({
      modelsCreated: 0,
      entitiesCreated: 1,
      enumsCreated: 1,
      scalarsCreated: 0,
      unionsCreated: 0,
      servicesCreated: 0,
      decoratorsCreated: 0,
      entityIds: [],
      modelIds: [],
      errors: [],
    });

    const { container } = renderWithQueryClient(
      <ImportDialog isOpen onClose={vi.fn()} domains={[{ id: "domain-1", name: "Domain" }]} />
    );

    await uploadTsp(container);
    await waitFor(() => expect(screen.getByTestId("typespec-import-review")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: /Import \d+ Asset\(s\)/ }));

    await waitFor(() =>
      expect(createDomainAssetsFromImportActionMock).toHaveBeenCalledTimes(1)
    );
    const payload = createDomainAssetsFromImportActionMock.mock.calls[0][0];
    expect(payload.domainId).toBe("domain-1");
    expect(payload.namespace).toBe("MyApp");
  });

  it("shows an error when the compiler action fails", async () => {
    importTypeSpecDocumentActionMock.mockResolvedValue({
      success: false,
      error: { code: "PARSE_ERROR", message: "bad syntax" },
    });

    const { container } = renderWithQueryClient(
      <ImportDialog isOpen onClose={vi.fn()} domains={[{ id: "domain-1", name: "Domain" }]} />
    );

    await uploadTsp(container);

    await waitFor(() => expect(screen.getByText("bad syntax")).toBeDefined());
  });
});
