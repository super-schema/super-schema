// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  push: vi.fn(), refresh: vi.fn(), invalidate: vi.fn(), toastSuccess: vi.fn(), updateTraitAction: vi.fn(), deleteTraitAction: vi.fn(), listPinnableVersionsAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, refresh: h.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, error: vi.fn() } }));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => h.invalidate }));
vi.mock("@/app/(dashboard)/schemas/trait-actions", () => ({ updateTraitAction: h.updateTraitAction, deleteTraitAction: h.deleteTraitAction }));
vi.mock("@/features/events/pin-actions", () => ({ listPinnableVersionsAction: h.listPinnableVersionsAction }));
import { TraitEditor } from "@/features/events/traits/TraitEditor";
import { GENERIC_ACTION_ERROR } from "@/lib/action-error";

const base = {
  owner: { level: "TENANT" as const, tenantId: "t" },
  crumbs: [{ label: "Traits" }],
  listHref: "/schemas/enterprise?tab=traits",
  entityOptions: [{ id: "e1", name: "CloudEventsHeaders", ownerLabel: "Enterprise", latestVersionId: "v1", latestVersionLabel: "1.0" }],
};
const messageTrait = { id: "t1", name: "CloudEvents", kind: "MESSAGE" as const, spec: { summary: "CE" }, headers: null, tenantId: "t", domainId: null, productId: null };

beforeEach(() => {
  vi.clearAllMocks();
  h.listPinnableVersionsAction.mockResolvedValue({ success: true, data: [{ id: "v1", label: "1.0" }] });
  h.updateTraitAction.mockResolvedValue({ success: true, data: { id: "t1" } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TraitEditor", () => {
  it("saves a MESSAGE trait with its spec JSON and pinned headers entity", async () => {
    render(<TraitEditor {...base} trait={messageTrait} />);
    fireEvent.change(screen.getByLabelText("Headers entity"), { target: { value: "e1" } });
    fireEvent.click(screen.getByTestId("trait-save"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateTraitAction).toHaveBeenCalledWith("t1", base.owner, { name: "CloudEvents", spec: { summary: "CE" }, headers: { entityId: "e1", entityVersionId: "v1" } });
    expect(h.toastSuccess).toHaveBeenCalledWith("Trait saved");
  });

  it("round-trips an existing headers pin (including an explicitly unpinned one) and lets it be cleared", async () => {
    const pinned = { ...messageTrait, headers: { entityId: "e1", entityVersionId: null } };
    const { rerender } = render(<TraitEditor {...base} trait={pinned} />);
    fireEvent.click(screen.getByTestId("trait-save"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    expect(h.updateTraitAction.mock.calls[0][2].headers).toEqual({ entityId: "e1", entityVersionId: null });
    rerender(<TraitEditor {...base} trait={pinned} />);
    fireEvent.change(screen.getByLabelText("Headers entity"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("trait-save"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(2));
    expect(h.updateTraitAction.mock.calls[1][2].headers).toBeNull();
  });

  it("has no headers picker for OPERATION traits and never sends headers", async () => {
    render(<TraitEditor {...base} trait={{ ...messageTrait, id: "t2", name: "Retry", kind: "OPERATION", spec: {} }} />);
    expect(screen.queryByLabelText("Headers entity")).toBeNull();
    expect(screen.getByText("operation trait")).toBeDefined();
    fireEvent.click(screen.getByTestId("trait-save"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateTraitAction).toHaveBeenCalledWith("t2", base.owner, { name: "Retry", spec: {}, headers: null });
  });

  it("blocks saving a trait object that is not valid JSON and renames through the Name input", async () => {
    render(<TraitEditor {...base} trait={messageTrait} />);
    fireEvent.change(screen.getByLabelText("Trait object (AsyncAPI fields, e.g. summary, correlationId, bindings)"), { target: { value: "[1]" } });
    fireEvent.click(screen.getByTestId("trait-save"));
    expect((await screen.findByTestId("trait-error")).textContent).toMatch(/Trait object must be a JSON object/);
    expect(h.updateTraitAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Trait object (AsyncAPI fields, e.g. summary, correlationId, bindings)"), { target: { value: '{"summary":"x"}' } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "CE2" } });
    fireEvent.click(screen.getByTestId("trait-save"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateTraitAction.mock.calls[0][2]).toMatchObject({ name: "CE2", spec: { summary: "x" } });
  });

  it("shows service errors with their fix, but never database error text", async () => {
    render(<TraitEditor {...base} trait={messageTrait} />);
    h.updateTraitAction.mockResolvedValueOnce({ success: false, error: "Trait is owned by another Domain scope.", code: "FORBIDDEN", suggestedFix: "Open it from its owning level to edit it." });
    fireEvent.click(screen.getByTestId("trait-save"));
    const alert = await screen.findByTestId("trait-error");
    expect(alert.textContent).toMatch(/owned by another Domain scope/);
    expect(alert.textContent).toMatch(/Open it from its owning level/);

    const raw = 'insert or update on table "schema_references" violates foreign key constraint';
    h.updateTraitAction.mockResolvedValueOnce({ success: false, error: raw, code: "DB_ERROR" });
    fireEvent.click(screen.getByTestId("trait-save"));
    await waitFor(() => expect(screen.getByTestId("trait-error").textContent).toBe(GENERIC_ACTION_ERROR));
    h.updateTraitAction.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    fireEvent.click(screen.getByTestId("trait-save"));
    await waitFor(() => expect(screen.getByTestId("trait-error").textContent).toBe(GENERIC_ACTION_ERROR));
    expect(document.body.textContent).not.toMatch(/schema_references|ECONNREFUSED/);
    expect((screen.getByTestId("trait-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("deletes after confirmation and returns to the list; declining or failing leaves the page alone", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<TraitEditor {...base} trait={messageTrait} />);
    fireEvent.click(screen.getByTestId("trait-delete"));
    expect(h.deleteTraitAction).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    h.deleteTraitAction.mockResolvedValueOnce({ success: false, error: "Trait is in use", code: "IN_USE" });
    fireEvent.click(screen.getByTestId("trait-delete"));
    expect((await screen.findByTestId("trait-error")).textContent).toMatch(/in use/);
    expect(h.push).not.toHaveBeenCalled();
    // Neither a declined confirmation nor a refused delete refreshes the explorer: nothing was deleted.
    expect(h.invalidate).not.toHaveBeenCalled();
    h.deleteTraitAction.mockResolvedValueOnce({ success: true, data: { id: "t1" } });
    fireEvent.click(screen.getByTestId("trait-delete"));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(base.listHref));
    expect(h.deleteTraitAction).toHaveBeenLastCalledWith("t1", base.owner);
    expect((screen.getByTestId("trait-delete") as HTMLButtonElement).disabled).toBe(true);
    // The explorer's React Query cache only refreshes through invalidate (revalidatePath does not reach it).
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });
});
