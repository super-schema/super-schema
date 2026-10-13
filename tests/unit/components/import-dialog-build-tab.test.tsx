/**
 * ImportDialog — "Build Visually" tab renders the VisualSchemaBuilder.
 *
 * @vitest-environment jsdom
 */

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  importTypeSpecDocumentAction: vi.fn(async () => ({ success: false, error: { code: "PARSE_ERROR", message: "mocked" } })),
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/openapi-import-actions", () => ({
  importOpenApiDocumentAction: vi.fn(),
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({
  createDomainAssetsFromImportAction: vi.fn(),
}));

import { ImportDialog } from "@/components/custom/ImportDialog";

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe("ImportDialog — Build Visually tab", () => {
  it("shows a 'Build Visually' tab in the input phase", () => {
    renderWithQueryClient(
      <ImportDialog
        isOpen={true}
        onClose={vi.fn()}
        domains={[{ id: "domain-1", name: "Domain" }]}
      />
    );
    expect(screen.getByRole("button", { name: /Build Visually/ })).toBeDefined();
  });

  it("renders the visual schema builder when the tab is clicked", () => {
    renderWithQueryClient(
      <ImportDialog
        isOpen={true}
        onClose={vi.fn()}
        domains={[{ id: "domain-1", name: "Domain" }]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Build Visually/ }));

    expect(screen.getByTestId("visual-schema-builder")).toBeDefined();
    expect(screen.getByTestId("jsonschema-visual-editor")).toBeDefined();
    expect(screen.getByTestId("detail-panel-json")).toBeDefined();
    expect(screen.getByRole("button", { name: /Add Property/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /Review & Import/ })).toBeDefined();
    // Format selector lists future formats as disabled placeholders.
    expect(screen.getByRole("button", { name: /Avro/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /Protobuf/ })).toBeDefined();
  });
});
