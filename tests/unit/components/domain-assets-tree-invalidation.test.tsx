/**
 * Data Type / API mutations on the domain & product pages must refresh the explorer tree
 * (its Data Types / APIs counts come from /api/domains-tree, not from revalidatePath).
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DomainTypesTab } from "@/app/(dashboard)/schemas/[domainSlug]/components/DomainTypesTab";
import { DomainApisTab, type ServiceData } from "@/app/(dashboard)/schemas/[domainSlug]/components/DomainApisTab";

const invalidate = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => invalidate }));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const actions = vi.hoisted(() => ({
  createSharedEnumAction: vi.fn(),
  updateSharedEnumAction: vi.fn(),
  deleteSharedEnumAction: vi.fn(),
  createCustomScalarAction: vi.fn(),
  deleteCustomScalarAction: vi.fn(),
  createUnionTypeAction: vi.fn(),
  updateUnionTypeAction: vi.fn(),
  deleteUnionTypeAction: vi.fn(),
  createServiceAction: vi.fn(),
  deleteServiceAction: vi.fn(),
  createOperationAction: vi.fn(),
  deleteOperationAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => actions);

const target = { level: "DOMAIN" as const, domainId: "d1" };

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(actions)) fn.mockResolvedValue({ success: true });
});
afterEach(cleanup);

describe("DomainTypesTab refreshes the explorer tree", () => {
  const ENUM = { id: "en1", name: "Status", values: ["A"], description: "" };

  function renderTypes() {
    render(
      <DomainTypesTab domainId="d1" target={target} sharedEnums={[ENUM]} customScalars={[]} unionTypes={[]} />
    );
  }

  it("after creating an enum", async () => {
    renderTypes();
    fireEvent.click(screen.getByRole("button", { name: /New Enum/i }));
    fireEvent.change(screen.getByPlaceholderText("EnumName"), { target: { value: "Color" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
  });

  it("not after a failed create", async () => {
    actions.createSharedEnumAction.mockResolvedValue({ error: "NAME_CONFLICT" });
    renderTypes();
    fireEvent.click(screen.getByRole("button", { name: /New Enum/i }));
    fireEvent.change(screen.getByPlaceholderText("EnumName"), { target: { value: "Color" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(actions.createSharedEnumAction).toHaveBeenCalled());
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("after updating an enum's values", async () => {
    renderTypes();
    fireEvent.click(screen.getByText("A").querySelector("button")!);
    await waitFor(() => expect(actions.updateSharedEnumAction).toHaveBeenCalled());
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
  });

  it("after deleting an enum", async () => {
    renderTypes();
    const card = screen.getByText("Status").parentElement!;
    fireEvent.click(card.querySelector("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(actions.deleteSharedEnumAction).toHaveBeenCalledWith("en1"));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
  });
});

describe("DomainApisTab refreshes the explorer tree", () => {
  const SERVICE: ServiceData = {
    id: "s1", name: "Orders", description: "", basePath: "/orders", scope: "DOMAIN", entity: null,
    operations: [{ id: "op1", name: "list", httpMethod: "GET", httpPath: "/", description: "", parameters: [], responses: [] }],
  };

  function renderApis() {
    render(<DomainApisTab domainId="d1" target={target} services={[SERVICE]} entities={[]} />);
  }

  it("after creating a service", async () => {
    renderApis();
    fireEvent.click(screen.getByRole("button", { name: /New Service/i }));
    fireEvent.change(screen.getByPlaceholderText("Service name"), { target: { value: "Billing" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Service" }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
  });

  it("not after a failed service create", async () => {
    actions.createServiceAction.mockResolvedValue({ error: "nope" });
    renderApis();
    fireEvent.click(screen.getByRole("button", { name: /New Service/i }));
    fireEvent.change(screen.getByPlaceholderText("Service name"), { target: { value: "Billing" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Service" }));
    await waitFor(() => expect(actions.createServiceAction).toHaveBeenCalled());
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("after deleting a service", async () => {
    renderApis();
    fireEvent.click(screen.getByTitle("Delete service"));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
  });

  it("after adding and deleting an operation", async () => {
    renderApis();
    fireEvent.click(screen.getByText("Orders"));
    fireEvent.click(screen.getByRole("button", { name: /Add Operation/i }));
    fireEvent.change(screen.getByPlaceholderText("operationName"), { target: { value: "get" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTitle("Delete operation"));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
  });
});
