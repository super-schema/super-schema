// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ listUsagesAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/usage-actions", () => ({ listUsagesAction: h.listUsagesAction }));
import { UsedByPanel } from "@/features/events/shared/UsedByPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UsedByPanel", () => {
  it("lists references with links, roles and draft badges; ghost rows render as plain text", async () => {
    h.listUsagesAction.mockResolvedValue({
      success: true,
      data: [
        { id: "r1", fromKind: "EVENT_SPEC_VERSION", role: "PAYLOAD", isDraft: false, target: "Order v2.1", label: "Event checkout v1.3", href: "/e?version=1.3" },
        { id: "r2", fromKind: "EVENT_SPEC", role: "KEY", isDraft: true, target: "Order v2.1", label: "Event checkout (draft)", href: "/e" },
        { id: "r3", fromKind: "ENTITY_VERSION", role: "FIELD", isDraft: false, target: "Order v2.1", label: "Entity version gone (deleted)", href: null },
      ],
    });
    render(<UsedByPanel subject={{ kind: "entity", entityId: "e1" }} />);
    expect((await screen.findByRole("link", { name: "Event checkout v1.3" })).getAttribute("href")).toBe("/e?version=1.3");
    expect(screen.getByRole("link", { name: "Event checkout (draft)" }).getAttribute("href")).toBe("/e");
    expect(screen.getByText("draft")).toBeDefined();
    expect(screen.getByText("KEY")).toBeDefined();
    // The ghost row is visible but is not a link.
    expect(screen.getByText("Entity version gone (deleted)")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Entity version gone (deleted)" })).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(h.listUsagesAction).toHaveBeenCalledWith({ kind: "entity", entityId: "e1" });
  });

  it("shows the empty and error states", async () => {
    h.listUsagesAction.mockResolvedValueOnce({ success: true, data: [] });
    render(<UsedByPanel subject={{ kind: "entity", entityId: "e1" }} />);
    expect(await screen.findByText("Nothing references this yet.")).toBeDefined();
    cleanup();
    h.listUsagesAction.mockResolvedValueOnce({ success: false, error: "boom" });
    render(<UsedByPanel subject={{ kind: "entity", entityId: "e1" }} />);
    expect((await screen.findByRole("alert")).textContent).toBe("boom");
  });

  it("shows a generic error when the action itself rejects (never hangs on the loading state)", async () => {
    h.listUsagesAction.mockRejectedValueOnce(new Error("network down"));
    render(<UsedByPanel subject={{ kind: "entity", entityId: "e1" }} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not load usages. Try again.");
    expect(screen.queryByText(/Looking up references/)).toBeNull();
  });

  it("shows a loading state first and re-queries when the subject changes", async () => {
    h.listUsagesAction.mockResolvedValue({ success: true, data: [] });
    const { rerender } = render(<UsedByPanel subject={{ kind: "entity", entityId: "e1" }} title="Referenced by" />);
    expect(screen.getByText(/Looking up references/)).toBeDefined();
    expect(screen.getByText("Referenced by")).toBeDefined();
    await screen.findByText("Nothing references this yet.");
    rerender(<UsedByPanel subject={{ kind: "entity", entityId: "e2" }} title="Referenced by" />);
    await waitFor(() => expect(h.listUsagesAction).toHaveBeenCalledTimes(2));
    expect(h.listUsagesAction).toHaveBeenLastCalledWith({ kind: "entity", entityId: "e2" });
  });

  it("does not re-query when the parent re-renders with an equal subject object", async () => {
    h.listUsagesAction.mockResolvedValue({ success: true, data: [] });
    const { rerender } = render(<UsedByPanel subject={{ kind: "entity", entityId: "e1" }} />);
    await screen.findByText("Nothing references this yet.");
    rerender(<UsedByPanel subject={{ kind: "entity", entityId: "e1" }} />);
    expect(h.listUsagesAction).toHaveBeenCalledTimes(1);
  });
});
