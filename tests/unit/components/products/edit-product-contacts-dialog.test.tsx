// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ updateProductAction: vi.fn(), refresh: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/product-actions", () => ({ updateProductAction: h.updateProductAction }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));

import { EditProductContactsDialog } from "@/app/(dashboard)/schemas/[domainSlug]/components/EditProductContactsDialog";
import type { ProductContactsValue } from "@/app/(dashboard)/schemas/[domainSlug]/components/ProductContacts";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const STORED: ProductContactsValue = {
  engineeringLead: "Jane Doe <jane@acme.com>",
  manager: "mo@acme.com",
  teamEmails: ["Platform Team <platform@acme.com>", "oncall@acme.com"],
};

function setup(props: { open?: boolean; contacts?: ProductContactsValue } = {}) {
  const onOpenChange = vi.fn();
  const ui = (open: boolean, contacts: ProductContactsValue) => (
    <EditProductContactsDialog productId="prd-1" productName="Checkout" contacts={contacts} open={open} onOpenChange={onOpenChange} />
  );
  const view = render(ui(props.open ?? true, props.contacts ?? STORED));
  return { onOpenChange, rerender: (open: boolean, contacts: ProductContactsValue = props.contacts ?? STORED) => view.rerender(ui(open, contacts)) };
}

const lead = () => screen.getByTestId("product-engineering-lead-input") as HTMLInputElement;
const manager = () => screen.getByTestId("product-manager-input") as HTMLInputElement;
const team = () => screen.getByTestId("product-team-emails-input") as HTMLInputElement;
const chips = () => screen.queryAllByTestId("product-team-emails-chip").map((chip) => chip.textContent ?? "");
const saveButton = () => screen.getByTestId("edit-product-contacts-save") as HTMLButtonElement;
const cancelButton = () => screen.getByTestId("edit-product-contacts-cancel") as HTMLButtonElement;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

beforeEach(() => {
  vi.clearAllMocks();
  h.updateProductAction.mockResolvedValue({ success: true, slug: "checkout" });
});
afterEach(() => cleanup());

describe("EditProductContactsDialog: content", () => {
  it("renders nothing while closed", () => {
    setup({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("edit-product-contacts-form")).toBeNull();
  });

  it("is a labelled dialog that names the product", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    expect(screen.getByRole("heading", { name: "Edit contacts" })).toBeDefined();
    expect(dialog.textContent).toContain("Checkout");
  });

  it("opens prefilled from the current contacts", () => {
    setup();
    expect(lead().value).toBe("Jane Doe <jane@acme.com>");
    expect(manager().value).toBe("mo@acme.com");
    expect(chips()).toEqual(["Platform Team platform@acme.com", "oncall@acme.com"]);
    expect(team().value).toBe("");
    expect(screen.getByLabelText("Engineering Lead")).toBe(lead());
    expect(screen.getByLabelText("Manager")).toBe(manager());
    expect(screen.getByLabelText("Team email addresses")).toBe(team());
  });

  it("opens empty for a product without contacts", () => {
    setup({ contacts: { engineeringLead: null, manager: null, teamEmails: [] } });
    expect(lead().value).toBe("");
    expect(manager().value).toBe("");
    expect(chips()).toEqual([]);
  });

  it("starts from the stored contacts again after the edits were cancelled", () => {
    const { rerender } = setup();
    type(lead(), "someone.else@acme.com");
    type(team(), "pending@acme.com");
    rerender(false);
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(true);
    expect(lead().value).toBe("Jane Doe <jane@acme.com>");
    expect(team().value).toBe("");
  });
});

describe("EditProductContactsDialog: validation", () => {
  it("shows the field error for an invalid email, calls no action and stays open", () => {
    const { onOpenChange } = setup();
    type(lead(), "jane");
    fireEvent.click(saveButton());

    expect(screen.getByTestId("product-engineering-lead-error").textContent).toContain("jane");
    expect(lead().getAttribute("aria-invalid")).toBe("true");
    expect(h.updateProductAction).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("reports every bad field at once, the way the create form does", () => {
    setup();
    type(lead(), "jane");
    type(manager(), "Doe, Jane <j@x.com>");
    type(team(), "broken");
    fireEvent.click(saveButton());

    expect(screen.getByTestId("product-engineering-lead-error")).toBeDefined();
    expect(screen.getByTestId("product-manager-error").textContent).toMatch(/quotes/i);
    expect(screen.getByTestId("product-team-emails-error").textContent).toContain("broken");
    expect(h.updateProductAction).not.toHaveBeenCalled();
  });

  it("saves once the invalid field is fixed", async () => {
    setup();
    type(lead(), "jane");
    fireEvent.click(saveButton());
    expect(h.updateProductAction).not.toHaveBeenCalled();

    type(lead(), "Jane <jane@acme.com>");
    expect(screen.queryByTestId("product-engineering-lead-error")).toBeNull();
    fireEvent.click(saveButton());

    await waitFor(() => expect(h.updateProductAction).toHaveBeenCalledTimes(1));
    expect(h.updateProductAction.mock.calls[0][1]).toMatchObject({ engineeringLead: "Jane <jane@acme.com>" });
  });
});

describe("EditProductContactsDialog: what is sent", () => {
  it("sends ONLY the three contact fields, so no other product field can be touched", async () => {
    setup();
    fireEvent.click(saveButton());

    await waitFor(() => expect(h.updateProductAction).toHaveBeenCalledTimes(1));
    expect(h.updateProductAction).toHaveBeenCalledWith("prd-1", {
      engineeringLead: "Jane Doe <jane@acme.com>",
      manager: "mo@acme.com",
      teamEmails: ["Platform Team <platform@acme.com>", "oncall@acme.com"],
    });
    expect(Object.keys(h.updateProductAction.mock.calls[0][1] as object).sort()).toEqual(["engineeringLead", "manager", "teamEmails"]);
  });

  it("clearing the manager field sends an empty manager (null), the others unchanged", async () => {
    setup();
    type(manager(), "");
    fireEvent.click(saveButton());

    await waitFor(() => expect(h.updateProductAction).toHaveBeenCalledTimes(1));
    expect(h.updateProductAction).toHaveBeenCalledWith("prd-1", {
      engineeringLead: "Jane Doe <jane@acme.com>",
      manager: null,
      teamEmails: ["Platform Team <platform@acme.com>", "oncall@acme.com"],
    });
  });

  it("emptying every field sends null, null and an empty list", async () => {
    setup();
    type(lead(), "   ");
    type(manager(), "");
    fireEvent.click(screen.getAllByTestId("product-team-emails-remove")[0]);
    fireEvent.click(screen.getAllByTestId("product-team-emails-remove")[0]);
    expect(chips()).toEqual([]);
    fireEvent.click(saveButton());

    await waitFor(() => expect(h.updateProductAction).toHaveBeenCalledTimes(1));
    expect(h.updateProductAction).toHaveBeenCalledWith("prd-1", { engineeringLead: null, manager: null, teamEmails: [] });
  });

  it("sends the canonical form of what was typed: names kept, quotes only where needed", async () => {
    setup({ contacts: { engineeringLead: null, manager: null, teamEmails: [] } });
    type(lead(), '  "Jane Doe"   <jane@acme.com> ');
    type(manager(), '"Roe, Rick" <rick@acme.com>');
    fireEvent.click(saveButton());

    await waitFor(() => expect(h.updateProductAction).toHaveBeenCalledTimes(1));
    expect(h.updateProductAction).toHaveBeenCalledWith("prd-1", {
      engineeringLead: "Jane Doe <jane@acme.com>",
      manager: '"Roe, Rick" <rick@acme.com>',
      teamEmails: [],
    });
  });

  it("does not lose a team address that was typed but not yet added", async () => {
    setup({ contacts: { engineeringLead: null, manager: null, teamEmails: ["a@acme.com"] } });
    type(team(), "pending@acme.com");
    fireEvent.click(saveButton());

    await waitFor(() => expect(h.updateProductAction).toHaveBeenCalledTimes(1));
    expect(h.updateProductAction.mock.calls[0][1]).toMatchObject({ teamEmails: ["a@acme.com", "pending@acme.com"] });
  });
});

describe("EditProductContactsDialog: outcome", () => {
  it("on success closes the dialog, toasts and refreshes the page", async () => {
    const { onOpenChange } = setup();
    type(lead(), "new.lead@acme.com");
    fireEvent.click(saveButton());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(h.toastSuccess).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it("shows the server's message, stays open and lets the user try again when the action answers with an error", async () => {
    h.updateProductAction.mockResolvedValueOnce({ error: "Product \"prd-1\" not found" });
    const { onOpenChange } = setup();
    fireEvent.click(saveButton());

    const alert = await screen.findByTestId("edit-product-contacts-error");
    expect(alert.textContent).toBe('Product "prd-1" not found');
    expect(alert.getAttribute("role")).toBe("alert");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(saveButton());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(h.updateProductAction).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("edit-product-contacts-error")).toBeNull();
  });

  it("shows the server's per-field messages next to their inputs and stays open", async () => {
    h.updateProductAction.mockResolvedValueOnce({
      error: "Manager message",
      fieldErrors: { manager: "Manager message", teamEmails: "Team message" },
    });
    const { onOpenChange } = setup();
    fireEvent.click(saveButton());

    expect((await screen.findByTestId("product-manager-error")).textContent).toBe("Manager message");
    expect(screen.getByTestId("product-team-emails-error").textContent).toBe("Team message");
    expect(screen.queryByTestId("edit-product-contacts-error")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(false);
  });

  it("shows the generic error, stays open and re-enables Save when the action is rejected", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.updateProductAction.mockRejectedValueOnce(new Error("Failed to fetch"));
    const { onOpenChange } = setup();
    fireEvent.click(saveButton());

    const alert = await screen.findByTestId("edit-product-contacts-error");
    expect(alert.textContent).toBe(GENERIC_ACTION_ERROR);
    expect(dialogText()).not.toContain("Failed to fetch");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().textContent).toBe("Save");
    expect(screen.getByRole("dialog")).toBeDefined();
    consoleError.mockRestore();
  });

  it("is busy while the save is in flight: Save and Cancel are disabled and a second click sends nothing", async () => {
    let resolve!: (value: unknown) => void;
    h.updateProductAction.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const { onOpenChange } = setup();
    fireEvent.click(saveButton());

    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(saveButton().textContent).toBe("Saving…");
    expect(cancelButton().disabled).toBe(true);
    expect(lead().disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(h.updateProductAction).toHaveBeenCalledTimes(1);

    resolve({ success: true, slug: "checkout" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("cannot be dismissed while the save is in flight (no X, Escape ignored) so a failure is never lost", async () => {
    let resolve!: (value: unknown) => void;
    h.updateProductAction.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const { onOpenChange } = setup();
    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
    fireEvent.click(saveButton());

    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();

    resolve({ error: "Product \"prd-1\" not found" });
    expect((await screen.findByTestId("edit-product-contacts-error")).textContent).toBe('Product "prd-1" not found');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("Escape closes the dialog when no save is running", () => {
    const { onOpenChange } = setup();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(h.updateProductAction).not.toHaveBeenCalled();
  });

  it("Cancel closes without calling the action", () => {
    const { onOpenChange } = setup();
    type(lead(), "changed@acme.com");
    fireEvent.click(cancelButton());

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(h.updateProductAction).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });
});

function dialogText(): string {
  return screen.getByRole("dialog").textContent ?? "";
}
