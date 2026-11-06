/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/hooks/useDomainsTree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useDomainsTree")>()),
  useInvalidateDomainsTree: () => vi.fn(),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const actions = vi.hoisted(() => ({
  createSharedEnumAction: vi.fn(),
  updateSharedEnumAction: vi.fn(),
  deleteSharedEnumAction: vi.fn(),
  createCustomScalarAction: vi.fn(),
  updateCustomScalarAction: vi.fn(),
  deleteCustomScalarAction: vi.fn(),
  createUnionTypeAction: vi.fn(),
  updateUnionTypeAction: vi.fn(),
  deleteUnionTypeAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => actions);

import { DomainTypesTab } from "@/app/(dashboard)/schemas/[domainSlug]/components/DomainTypesTab";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const TARGET = { level: "DOMAIN", domainId: "d1" } as const;
const ENUM = { id: "en1", name: "LoginIntent", values: ["LOGIN_SUCCESS", "LOGIN_FAILURE"], description: "Intents.", valueDescriptions: { LOGIN_SUCCESS: "Logged in." } };
const SCALAR = { id: "sc1", name: "CountryCode", baseType: "string", logicalType: "string", format: null, pattern: "^[A-Z]{2}$", constraints: { minLength: 2, maxLength: 2 }, description: "ISO alpha-2" };

function renderTab(tab: "enums" | "scalars") {
  render(<DomainTypesTab domainId="d1" target={TARGET} sharedEnums={[ENUM]} customScalars={[SCALAR]} unionTypes={[]} />);
  if (tab === "scalars") fireEvent.click(screen.getAllByTestId("data-type-subtab").find((b) => b.getAttribute("data-subtab") === "scalars")!);
}

describe("enum edit form", () => {
  it("shows one visible value-to-description mapping without a disclosure", () => {
    renderTab("enums");
    const card = screen.getByTestId("data-type-card");
    const mapping = within(card).getByTestId("enum-value-descriptions");
    expect(card.querySelector("summary")).toBeNull();
    expect(within(card).getAllByText("LOGIN_SUCCESS")).toHaveLength(1);
    expect(within(card).getAllByText("LOGIN_FAILURE")).toHaveLength(1);
    expect(within(mapping).getByText("LOGIN_SUCCESS").parentElement?.textContent).toContain("Logged in.");
    expect(within(mapping).getByText("LOGIN_FAILURE").parentElement?.textContent).toContain("No description");
  });

  it("keeps add and remove controls working in the visible mapping", async () => {
    actions.updateSharedEnumAction.mockResolvedValue({ success: true });
    renderTab("enums");
    const card = screen.getByTestId("data-type-card");
    fireEvent.click(within(card).getByRole("button", { name: "Remove LOGIN_FAILURE" }));
    await waitFor(() => expect(actions.updateSharedEnumAction).toHaveBeenCalledWith("en1", { values: ["LOGIN_SUCCESS"] }));
    expect(within(card).queryByText("LOGIN_FAILURE")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Add value" }));
    fireEvent.change(within(card).getByRole("textbox", { name: "New value" }), { target: { value: "LOCKED" } });
    fireEvent.keyDown(within(card).getByRole("textbox", { name: "New value" }), { key: "Enter" });
    await waitFor(() => expect(actions.updateSharedEnumAction).toHaveBeenCalledWith("en1", { values: ["LOGIN_SUCCESS", "LOCKED"] }));
    expect(within(card).getByText("LOCKED")).toBeDefined();
  });
  it("shows the saved value descriptions and edits them", async () => {
    actions.updateSharedEnumAction.mockResolvedValue({ success: true, updatedFields: 4 });
    renderTab("enums");
    const card = screen.getByTestId("data-type-card");
    expect(within(card).getByTestId("enum-described-count").textContent).toBe("1 described");
    expect(within(card).getByTestId("enum-value-descriptions").textContent).toContain("Logged in.");

    fireEvent.click(within(card).getByTestId("data-type-edit"));
    const failure = within(card).getAllByTestId("enum-value-description").find((i) => i.getAttribute("data-member") === "LOGIN_FAILURE")!;
    fireEvent.change(failure, { target: { value: "Wrong password." } });
    fireEvent.change(within(card).getByTestId("data-type-edit-description"), { target: { value: "Login intents." } });
    fireEvent.click(within(card).getByTestId("data-type-edit-save"));

    await waitFor(() => expect(actions.updateSharedEnumAction).toHaveBeenCalledWith("en1", {
      description: "Login intents.",
      valueDescriptions: { LOGIN_SUCCESS: "Logged in.", LOGIN_FAILURE: "Wrong password." },
    }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Enum "LoginIntent" saved · 4 fields updated'));
    expect(within(card).queryByTestId("data-type-edit-form")).toBeNull();
    expect(within(card).getByTestId("enum-described-count").textContent).toBe("2 described");
  });

  it("cancel leaves everything as it was", () => {
    renderTab("enums");
    const card = screen.getByTestId("data-type-card");
    fireEvent.click(within(card).getByTestId("data-type-edit"));
    fireEvent.click(within(card).getByTestId("data-type-edit-cancel"));
    expect(actions.updateSharedEnumAction).not.toHaveBeenCalled();
    expect(within(card).getByText("Intents.")).toBeDefined();
  });

  it("keeps the form open on a server error", async () => {
    actions.updateSharedEnumAction.mockResolvedValue({ error: "nope" });
    renderTab("enums");
    const card = screen.getByTestId("data-type-card");
    fireEvent.click(within(card).getByTestId("data-type-edit"));
    fireEvent.click(within(card).getByTestId("data-type-edit-save"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("nope"));
    expect(within(card).getByTestId("data-type-edit-form")).toBeDefined();
  });
});

describe("scalar edit form", () => {
  it("shows the bounds as badges and saves edited ones", async () => {
    actions.updateCustomScalarAction.mockResolvedValue({ success: true, updatedFields: 9 });
    renderTab("scalars");
    const card = screen.getByTestId("data-type-card");
    expect(within(card).getAllByTestId("scalar-constraint").map((b) => b.textContent)).toEqual(["minLength: 2", "maxLength: 2"]);

    fireEvent.click(within(card).getByTestId("data-type-edit"));
    const bound = (key: string) => within(card).getAllByTestId("scalar-edit-bound").find((i) => i.getAttribute("data-constraint") === key) as HTMLInputElement;
    expect(bound("maxValue").disabled).toBe(true); // numeric bounds do not apply to a string
    fireEvent.change(bound("maxLength"), { target: { value: "3" } });
    fireEvent.change(within(card).getByTestId("scalar-edit-pattern"), { target: { value: "^[A-Z]{2,3}$" } });
    fireEvent.click(within(card).getByTestId("data-type-edit-save"));

    await waitFor(() => expect(actions.updateCustomScalarAction).toHaveBeenCalledWith("sc1", {
      description: "ISO alpha-2", baseType: "string", logicalType: "string", format: null, pattern: "^[A-Z]{2,3}$", constraints: { minLength: 2, maxLength: 3 },
    }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Scalar "CountryCode" saved · 9 fields updated'));
    expect(within(card).getAllByTestId("scalar-constraint").map((b) => b.textContent)).toEqual(["minLength: 2", "maxLength: 3"]);
  });

  it("refuses min > max without calling the server", () => {
    renderTab("scalars");
    const card = screen.getByTestId("data-type-card");
    fireEvent.click(within(card).getByTestId("data-type-edit"));
    const min = within(card).getAllByTestId("scalar-edit-bound").find((i) => i.getAttribute("data-constraint") === "minLength")!;
    fireEvent.change(min, { target: { value: "5" } });
    fireEvent.click(within(card).getByTestId("data-type-edit-save"));
    expect(within(card).getByTestId("data-type-edit-error").textContent).toBe("Min length is greater than max length");
    expect(actions.updateCustomScalarAction).not.toHaveBeenCalled();
  });

  it("switching to a numeric base enables the value bounds", () => {
    renderTab("scalars");
    const card = screen.getByTestId("data-type-card");
    fireEvent.click(within(card).getByTestId("data-type-edit"));
    fireEvent.change(within(card).getByTestId("scalar-edit-base"), { target: { value: "int32" } });
    const max = within(card).getAllByTestId("scalar-edit-bound").find((i) => i.getAttribute("data-constraint") === "maxValue") as HTMLInputElement;
    const maxLen = within(card).getAllByTestId("scalar-edit-bound").find((i) => i.getAttribute("data-constraint") === "maxLength") as HTMLInputElement;
    expect(max.disabled).toBe(false);
    expect(maxLen.disabled).toBe(true);
  });
});
