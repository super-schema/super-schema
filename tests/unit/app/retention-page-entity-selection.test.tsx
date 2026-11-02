// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// The retention page edits one entity at a time. The editor's form is the policy of the entity it shows: selecting another entity shows THAT
// entity's policy (or the defaults), and Save writes the form for the entity it was loaded for, never the previous entity's form. A save still
// running for one entity does not change the form of the entity selected since; selecting that entity again shows the policy that was submitted
// (its Save waits for the answer), and the answer does not bring the old policy back. A save does not take the selection back to the entity the
// URL names, and the toasts name the entity.

const h = vi.hoisted(() => ({
  search: new URLSearchParams(),
  getEntitiesForRetentionAction: vi.fn(),
  updateRetentionPolicyAction: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useSearchParams: () => h.search }));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/app/(dashboard)/governance/retention/actions", () => ({
  getEntitiesForRetentionAction: h.getEntitiesForRetentionAction,
  updateRetentionPolicyAction: h.updateRetentionPolicyAction,
}));

import RetentionPoliciesPage from "@/app/(dashboard)/governance/retention/page";

// Each test renders the whole page and clicks through its entities in jsdom (2 to 4 s idle): a loaded run goes past the 5 s default.
vi.setConfig({ testTimeout: 30_000 });

// Accounts holds an indefinite policy, Orders an age-based one with its own period and action, Invoices none.
const ENTITIES = [
  { id: "ent-accounts", name: "Accounts", domainName: "Finance", metadata: { retentionPolicy: { strategy: "indefinite", action: "archive" } }, fields: [] },
  {
    id: "ent-orders",
    name: "Orders",
    domainName: "Sales",
    metadata: { retentionPolicy: { strategy: "age-based", period: 3, periodUnit: "years", action: "anonymize" } },
    fields: [],
  },
  { id: "ent-invoices", name: "Invoices", domainName: "Finance", metadata: {}, fields: [] },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.search = new URLSearchParams();
  h.getEntitiesForRetentionAction.mockResolvedValue({ entities: ENTITIES });
  h.updateRetentionPolicyAction.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
});

const editor = () => screen.getByTestId("retention-policy-editor");
const entityButton = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}\\b`) });
const pressed = (testId: string) => screen.getByTestId(testId).getAttribute("aria-pressed");
const valueOf = (testId: string) => (screen.getByTestId(testId) as HTMLInputElement | HTMLSelectElement).value;

async function renderPage(): Promise<void> {
  render(<RetentionPoliciesPage />);
  await screen.findByRole("button", { name: /^Accounts\b/ });
}

function selectEntity(name: string): void {
  fireEvent.click(entityButton(name));
  expect(within(editor()).getByRole("heading", { name, level: 3 })).toBeTruthy();
}

describe("retention page: the editor belongs to the selected entity", () => {
  it("selecting another entity shows its own policy, and Save writes that policy for that entity", async () => {
    await renderPage();
    selectEntity("Accounts");
    expect(pressed("retention-strategy-indefinite")).toBe("true");

    selectEntity("Orders");
    expect(pressed("retention-strategy-indefinite")).toBe("false");
    expect(pressed("retention-strategy-age-based")).toBe("true");
    expect(pressed("retention-action-anonymize")).toBe("true");
    expect(valueOf("retention-period")).toBe("3");
    expect(valueOf("retention-period-unit")).toBe("years");

    fireEvent.click(screen.getByTestId("retention-save"));
    await waitFor(() => expect(h.updateRetentionPolicyAction).toHaveBeenCalledTimes(1));
    expect(h.updateRetentionPolicyAction).toHaveBeenCalledWith("ent-orders", {
      strategy: "age-based",
      action: "anonymize",
      period: 3,
      periodUnit: "years",
    });
  });

  it("an entity with no policy starts from the defaults, and Save never writes the previous entity's policy for it", async () => {
    await renderPage();
    selectEntity("Accounts");
    selectEntity("Invoices");
    expect(pressed("retention-strategy-indefinite")).toBe("false");
    expect(pressed("retention-strategy-age-based")).toBe("true");
    expect(pressed("retention-action-delete")).toBe("true");

    fireEvent.click(screen.getByTestId("retention-save"));
    await waitFor(() => expect(h.updateRetentionPolicyAction).toHaveBeenCalledTimes(1));
    expect(h.updateRetentionPolicyAction).toHaveBeenCalledWith("ent-invoices", {
      strategy: "age-based",
      action: "delete",
      period: 90,
      periodUnit: "days",
    });
  });

  it("a save does not take the selection back to the entity the URL names", async () => {
    h.search = new URLSearchParams("entity=ent-accounts");
    await renderPage();
    await waitFor(() => expect(within(editor()).getByRole("heading", { name: "Accounts", level: 3 })).toBeTruthy());

    selectEntity("Orders");
    fireEvent.click(screen.getByTestId("retention-action-delete"));
    fireEvent.click(screen.getByTestId("retention-save"));
    // The saved policy reaches the list last: once it is there, the page has taken the answer in, and the selection is checked.
    await waitFor(() => expect(entityButton("Orders").textContent).toContain("Delete after 3 years"));
    await act(async () => undefined);
    expect(within(editor()).getByRole("heading", { name: "Orders", level: 3 })).toBeTruthy();
  });

  it("a save still running for one entity does not change the form of the entity selected since", async () => {
    let finishSave: (value: { success: boolean }) => void = () => undefined;
    h.updateRetentionPolicyAction.mockImplementationOnce(() => new Promise((resolve) => (finishSave = resolve)));
    await renderPage();

    selectEntity("Orders");
    fireEvent.click(screen.getByTestId("retention-action-delete"));
    fireEvent.click(screen.getByTestId("retention-save"));
    await waitFor(() => expect(h.updateRetentionPolicyAction).toHaveBeenCalledTimes(1));

    selectEntity("Accounts");
    expect(pressed("retention-strategy-indefinite")).toBe("true");
    expect(pressed("retention-action-archive")).toBe("true");
    // The save of Orders does not hold Accounts' Save button: its "saving" state belongs to the form that started it.
    expect((screen.getByTestId("retention-save") as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      finishSave({ success: true });
    });
    await waitFor(() => expect(entityButton("Orders").textContent).toContain("Delete after 3 years"));
    await act(async () => undefined);
    expect(pressed("retention-strategy-indefinite")).toBe("true");
    expect(pressed("retention-action-archive")).toBe("true");
    expect(h.updateRetentionPolicyAction).toHaveBeenCalledWith("ent-orders", {
      strategy: "age-based",
      action: "delete",
      period: 3,
      periodUnit: "years",
    });
  });

  it("selecting an entity whose save is still running shows the policy that was submitted, and its Save waits for the answer", async () => {
    let finishSave: (value: { success: boolean }) => void = () => undefined;
    h.updateRetentionPolicyAction.mockImplementationOnce(() => new Promise((resolve) => (finishSave = resolve)));
    await renderPage();

    selectEntity("Orders");
    fireEvent.click(screen.getByTestId("retention-action-delete"));
    fireEvent.click(screen.getByTestId("retention-save"));
    await waitFor(() => expect(h.updateRetentionPolicyAction).toHaveBeenCalledTimes(1));

    // The list still holds Orders' old policy until the answer lands: the form shows what was submitted, and Save waits for the answer.
    selectEntity("Accounts");
    selectEntity("Orders");
    expect(pressed("retention-action-delete")).toBe("true");
    expect(pressed("retention-action-anonymize")).toBe("false");
    expect((screen.getByTestId("retention-save") as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      finishSave({ success: true });
    });
    await waitFor(() => expect(entityButton("Orders").textContent).toContain("Delete after 3 years"));
    await act(async () => undefined);
    // The answer does not bring the old policy back into the form, and the entity can be saved again.
    expect(pressed("retention-action-delete")).toBe("true");
    expect((screen.getByTestId("retention-save") as HTMLButtonElement).disabled).toBe(false);
    expect(h.updateRetentionPolicyAction).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("retention-save"));
    await waitFor(() => expect(h.updateRetentionPolicyAction).toHaveBeenCalledTimes(2));
    expect(h.updateRetentionPolicyAction).toHaveBeenLastCalledWith("ent-orders", {
      strategy: "age-based",
      action: "delete",
      period: 3,
      periodUnit: "years",
    });
  });

  it("the success toast names the entity the policy was saved for", async () => {
    await renderPage();
    selectEntity("Orders");
    fireEvent.click(screen.getByTestId("retention-action-delete"));
    fireEvent.click(screen.getByTestId("retention-save"));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Retention policy saved for Orders"));
  });

  it("a refused save names the entity, frees its Save again, and the form shows the list's policy once the selection comes back", async () => {
    h.updateRetentionPolicyAction.mockResolvedValueOnce({ error: "You do not have permission to do this", code: "FORBIDDEN" });
    await renderPage();

    selectEntity("Orders");
    fireEvent.click(screen.getByTestId("retention-action-delete"));
    fireEvent.click(screen.getByTestId("retention-save"));
    await waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith("Retention policy for Orders was not saved: You do not have permission to do this")
    );
    expect(h.toast.success).not.toHaveBeenCalled();
    expect((screen.getByTestId("retention-save") as HTMLButtonElement).disabled).toBe(false);

    // Nothing was saved, so the list still holds Orders' policy, and that is what the form shows once the selection comes back to it.
    selectEntity("Accounts");
    selectEntity("Orders");
    expect(pressed("retention-action-anonymize")).toBe("true");
    expect(pressed("retention-action-delete")).toBe("false");
  });
});
