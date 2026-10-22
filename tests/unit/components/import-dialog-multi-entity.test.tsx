/**
 * ImportDialog — multi-asset routing for Protobuf / Avro / JSON Schema
 * (Epic 15.5): a document defining more than one asset goes through the
 * shared multi-asset review screen and createDomainAssetsFromImportAction;
 * a single-asset document keeps the single-entity review.
 *
 * @vitest-environment jsdom
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createDomainAssetsFromImportActionMock } = vi.hoisted(() => ({
  createDomainAssetsFromImportActionMock: vi.fn(),
}));

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
  importTypeSpecDocumentAction: vi.fn(),
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/openapi-import-actions", () => ({
  importOpenApiDocumentAction: vi.fn(),
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({
  createDomainAssetsFromImportAction: createDomainAssetsFromImportActionMock,
}));

import { ImportDialog } from "@/components/custom/ImportDialog";

const ORDER_PROTO = readFileSync(
  path.resolve(process.cwd(), "tests/fixtures/importers/order.proto"),
  "utf8"
);

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImportDialog isOpen onClose={vi.fn()} domains={[{ id: "domain-1", name: "Domain" }]} />
    </QueryClientProvider>
  );
}

function upload(container: HTMLElement, content: string, filename: string) {
  fireEvent.click(screen.getByRole("button", { name: "Upload File" }));
  const input = container.querySelector(
    '[data-testid="drop-zone-single"] input[type="file"]'
  ) as HTMLInputElement | null;
  expect(input).toBeTruthy();
  fireEvent.change(input!, { target: { files: [new File([content], filename, { type: "text/plain" })] } });
}

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe("ImportDialog — multi-entity Protobuf import", () => {
  it("routes a multi-message .proto to the multi-asset review with every message and enum", async () => {
    const { container } = renderDialog();
    upload(container, ORDER_PROTO, "order.proto");

    await waitFor(() => expect(screen.getByTestId("typespec-import-review")).toBeDefined());
    expect(screen.getByText("Review Protobuf Import")).toBeDefined();
    // Field details repeat reference targets, so each asset name is looked up inside its own row.
    for (const name of ["Order", "Order_LineItem", "Card", "Customer"]) {
      expect(within(screen.getByTestId(`import-model-${name}`)).getAllByText(name).length).toBeGreaterThan(0);
    }
    for (const name of ["OrderStatus", "Order_LineItem_Kind"]) {
      expect(within(screen.getByTestId(`import-enum-${name}`)).getByText(name)).toBeDefined();
    }
    expect(screen.getByText(/OrderService/)).toBeDefined();
  });

  it("persists every selected message as an entity, plus the enums", async () => {
    createDomainAssetsFromImportActionMock.mockResolvedValue({
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
    const { container } = renderDialog();
    upload(container, ORDER_PROTO, "order.proto");
    await waitFor(() => expect(screen.getByTestId("typespec-import-review")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: /Import \d+ Asset\(s\)/ }));

    await waitFor(() => expect(createDomainAssetsFromImportActionMock).toHaveBeenCalledTimes(1));
    const payload = createDomainAssetsFromImportActionMock.mock.calls[0][0];
    expect(payload.domainId).toBe("domain-1");
    expect(payload.namespace).toBe("shop.orders.v1");
    expect(payload.entities.map((e: { name: string }) => e.name)).toEqual([
      "Order",
      "Order_LineItem",
      "Card",
      "Customer",
    ]);
    expect(payload.sharedEnums.map((e: { name: string }) => e.name)).toEqual([
      "OrderStatus",
      "Order_LineItem_Kind",
    ]);
    const items = payload.entities[0].fields.find((f: { name: string }) => f.name === "items");
    expect(items.decorators).toMatchObject({ referencedEntityName: "Order_LineItem" });
  });

  it("keeps a single-message .proto on the single-entity review", async () => {
    const { container } = renderDialog();
    upload(container, `syntax = "proto3";\nmessage User { string id = 1; }`, "user.proto");

    await waitFor(() => expect(screen.getByTestId("import-review-screen")).toBeDefined());
    expect((screen.getByTestId("import-entity-name") as HTMLInputElement).value).toBe("User");
    expect(screen.queryByTestId("typespec-import-review")).toBeNull();
  });
});
