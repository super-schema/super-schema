// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ listPinnableVersionsAction: vi.fn() }));
vi.mock("@/features/events/pin-actions", () => ({ listPinnableVersionsAction: h.listPinnableVersionsAction }));
import { EntityPinPicker, type EntityOption } from "@/features/events/shared/EntityPinPicker";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const entities: EntityOption[] = [
  { id: "e1", name: "Order", ownerLabel: "Payments / Checkout", latestVersionId: "v21", latestVersionLabel: "2.1" },
  { id: "e2", name: "CloudEventsHeaders", ownerLabel: "Enterprise", latestVersionId: null, latestVersionLabel: null },
];
const loadVersions = vi.fn(async (entityId: string) => (entityId === "e1" ? [{ id: "v21", label: "2.1" }, { id: "v20", label: "2.0" }] : []));

describe("EntityPinPicker", () => {
  it("defaults a newly chosen entity to its latest published version", () => {
    const onChange = vi.fn();
    render(<EntityPinPicker id="payload" label="Payload" entities={entities} value={null} onChange={onChange} loadVersions={loadVersions} />);
    fireEvent.change(screen.getByLabelText("Payload entity"), { target: { value: "e1" } });
    expect(onChange).toHaveBeenCalledWith({ entityId: "e1", entityVersionId: "v21" });
  });

  it("lists published versions, flags a stale pin and an unpinned draft", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <EntityPinPicker id="payload" label="Payload" entities={entities} value={{ entityId: "e1", entityVersionId: "v20" }} onChange={onChange} loadVersions={loadVersions} />
    );
    await waitFor(() => expect(screen.getByRole("option", { name: "v2.0" })).toBeDefined());
    expect(screen.getByTestId("payload-newer").textContent).toBe("Newer version available (v2.1)");
    fireEvent.change(screen.getByLabelText("Payload version"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith({ entityId: "e1", entityVersionId: null });
    rerender(<EntityPinPicker id="payload" label="Payload" entities={entities} value={{ entityId: "e1", entityVersionId: null }} onChange={onChange} loadVersions={loadVersions} />);
    expect(screen.getByText(/publishing is blocked/)).toBeDefined();
  });

  it("allows clearing an optional pin", () => {
    const onChange = vi.fn();
    render(<EntityPinPicker id="headers" label="Headers" optional entities={entities} value={{ entityId: "e2", entityVersionId: null }} onChange={onChange} loadVersions={loadVersions} />);
    fireEvent.change(screen.getByLabelText("Headers entity"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows a visible error when loading versions rejects, and recovers for another entity", async () => {
    const failing = vi.fn(async (entityId: string) => {
      if (entityId === "e1") throw new Error("Could not load versions");
      return [{ id: "v9", label: "9.0" }];
    });
    const onChange = vi.fn();
    const { rerender } = render(
      <EntityPinPicker id="payload" label="Payload" entities={entities} value={{ entityId: "e1", entityVersionId: "v21" }} onChange={onChange} loadVersions={failing} />
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not load published versions: Could not load versions/);
    // The current pin stays selectable as an opaque "pinned version" instead of vanishing.
    expect(screen.getByRole("option", { name: "pinned version" })).toBeDefined();
    rerender(
      <EntityPinPicker id="payload" label="Payload" entities={entities} value={{ entityId: "e2", entityVersionId: null }} onChange={onChange} loadVersions={failing} />
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("does not turn a failing action result into a silent empty list (default loader)", async () => {
    h.listPinnableVersionsAction.mockResolvedValueOnce({ success: false, error: "Entity not found", code: "NOT_FOUND" });
    render(<EntityPinPicker id="payload" label="Payload" entities={entities} value={{ entityId: "e1", entityVersionId: null }} onChange={vi.fn()} />);
    expect((await screen.findByTestId("payload-versions-error")).textContent).toMatch(/Entity not found/);
    expect(h.listPinnableVersionsAction).toHaveBeenCalledWith("e1");
  });

  it("uses the tenant-scoped pin action by default and lists its versions", async () => {
    h.listPinnableVersionsAction.mockResolvedValueOnce({ success: true, data: [{ id: "v21", label: "2.1" }, { id: "v20", label: "2.0" }] });
    render(<EntityPinPicker id="payload" label="Payload" entities={entities} value={{ entityId: "e1", entityVersionId: "v20" }} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "v2.1" })).toBeDefined());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
