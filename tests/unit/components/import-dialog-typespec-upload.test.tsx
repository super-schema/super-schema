/**
 * ImportDialog regression tests for uploaded TypeSpec documents.
 *
 * @vitest-environment jsdom
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const { createDomainAssetsFromImportActionMock } = vi.hoisted(() => ({
  createDomainAssetsFromImportActionMock: vi.fn(),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <span className={className}>{children}</span>,
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
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({
  createDomainAssetsFromImportAction: createDomainAssetsFromImportActionMock,
}));

import { ImportDialog } from "@/components/custom/ImportDialog";

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe("ImportDialog", () => {
  it("routes uploaded .tsp files with many models to the TypeSpec review flow", async () => {
    const content = readFileSync(
      path.resolve(process.cwd(), "examples/cds/temp/customer_1.tsp"),
      "utf8"
    );

    const file = new File([content], "customer_1.tsp", { type: "text/plain" });

    const { container } = render(
      <ImportDialog
        isOpen={true}
        onClose={vi.fn()}
        domains={[{ id: "domain-1", name: "Customer Data Store" }]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Upload File" }));

    const input = container.querySelector(
      '[data-testid="drop-zone-single"] input[type="file"]'
    ) as HTMLInputElement | null;

    expect(input).toBeTruthy();
    if (!input) return;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByTestId("typespec-import-review")).toBeDefined();
    });

    expect(
      screen.getByText(
        /11 model\(s\),\s*5 enum\(s\),\s*4 scalar\(s\),\s*0 union\(s\),\s*0 API service\(s\),\s*0 decorator definition\(s\)/
      )
    ).toBeDefined();
    expect(screen.getByText("Customer")).toBeDefined();
    expect(screen.getByText("Locale")).toBeDefined();
  });

  it("submits models plus the recommended entity registration from customer_1.tsp", async () => {
    createDomainAssetsFromImportActionMock.mockResolvedValue({
      modelsCreated: 11,
      entitiesCreated: 1,
      enumsCreated: 5,
      scalarsCreated: 4,
      unionsCreated: 0,
      servicesCreated: 0,
      decoratorsCreated: 0,
      entityIds: [],
      modelIds: [],
      errors: [],
    });

    const content = readFileSync(
      path.resolve(process.cwd(), "examples/cds/temp/customer_1.tsp"),
      "utf8"
    );

    const file = new File([content], "customer_1.tsp", { type: "text/plain" });

    const { container } = render(
      <ImportDialog
        isOpen={true}
        onClose={vi.fn()}
        domains={[{ id: "domain-1", name: "PayPal.CustomerDataStore" }]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Upload File" }));

    const input = container.querySelector(
      '[data-testid="drop-zone-single"] input[type="file"]'
    ) as HTMLInputElement | null;

    expect(input).toBeTruthy();
    if (!input) return;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByTestId("typespec-import-review")).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: /Import 21 Asset\(s\)/ }));

    await waitFor(() => {
      expect(createDomainAssetsFromImportActionMock).toHaveBeenCalledTimes(1);
    });

    const payload = createDomainAssetsFromImportActionMock.mock.calls[0][0];

    expect(payload.domainId).toBe("domain-1");
    expect(payload.namespace).toBe("PayPal.CustomerDataStore");
    expect(payload.models).toHaveLength(11);
    expect(payload.entities).toHaveLength(1);
    expect(payload.entities[0].name).toBe("Customer");
    expect(payload.sharedEnums).toHaveLength(5);
    expect(payload.customScalars).toHaveLength(4);
    expect(payload.unionTypes).toHaveLength(0);
    expect(payload.services).toHaveLength(0);
    expect(payload.decoratorDefinitions).toHaveLength(0);

    expect(
      payload.sharedEnums.find((sharedEnum: { name: string }) => sharedEnum.name === "Brand")
    ).toMatchObject({
      name: "Brand",
      description: "Brand namespace for customer. Normalized to UPPERCASE.",
    });

    expect(
      payload.customScalars.find((scalar: { name: string }) => scalar.name === "uuid")
    ).toMatchObject({
      name: "uuid",
      baseType: "string",
      format: "uuid",
    });

    expect(
      payload.customScalars.find(
        (scalar: { name: string }) => scalar.name === "CountryCode"
      )
    ).toMatchObject({
      name: "CountryCode",
      baseType: "string",
      pattern: "^[A-Z]{2}$",
      description: "ISO 3166-1 alpha-2 country code",
    });
  });

  it("lets the user opt additional imported models into entity registration", async () => {
    createDomainAssetsFromImportActionMock.mockResolvedValue({
      modelsCreated: 11,
      entitiesCreated: 2,
      enumsCreated: 5,
      scalarsCreated: 4,
      unionsCreated: 0,
      servicesCreated: 0,
      decoratorsCreated: 0,
      entityIds: [],
      modelIds: [],
      errors: [],
    });

    const content = readFileSync(
      path.resolve(process.cwd(), "examples/cds/temp/customer_1.tsp"),
      "utf8"
    );

    const file = new File([content], "customer_1.tsp", { type: "text/plain" });

    const { container } = render(
      <ImportDialog
        isOpen={true}
        onClose={vi.fn()}
        domains={[{ id: "domain-1", name: "PayPal.CustomerDataStore" }]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Upload File" }));

    const input = container.querySelector(
      '[data-testid="drop-zone-single"] input[type="file"]'
    ) as HTMLInputElement | null;

    expect(input).toBeTruthy();
    if (!input) return;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByTestId("typespec-import-review")).toBeDefined();
    });

    fireEvent.click(screen.getByLabelText("TaxDetails entity"));
    fireEvent.click(screen.getByRole("button", { name: /Import 22 Asset\(s\)/ }));

    await waitFor(() => {
      expect(createDomainAssetsFromImportActionMock).toHaveBeenCalledTimes(1);
    });

    const payload = createDomainAssetsFromImportActionMock.mock.calls[0][0];
    expect(payload.entities.map((entity: { name: string }) => entity.name)).toEqual(
      expect.arrayContaining(["TaxDetails", "Customer"])
    );
    expect(payload.entities).toHaveLength(2);
  });
});
