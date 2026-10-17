// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ listUsagesAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/usage-actions", () => ({ listUsagesAction: h.listUsagesAction }));
import { UsedByPanel } from "@/features/events/shared/UsedByPanel";
import { USAGE_ROW_LIMIT } from "@/lib/events/usage";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ENTITY = { kind: "entity", entityId: "e1" } as const;
const none = { success: true, data: { rows: [], truncated: false } };

describe("UsedByPanel", () => {
  it("lists references with links, roles and draft badges; ghost rows render as plain text", async () => {
    h.listUsagesAction.mockResolvedValue({
      success: true,
      data: {
        rows: [
          { id: "r1", fromKind: "EVENT_SPEC_VERSION", role: "PAYLOAD", isDraft: false, target: "Order v2.1", label: "Event checkout v1.3", href: "/e?version=1.3" },
          { id: "r2", fromKind: "EVENT_SPEC", role: "KEY", isDraft: true, target: "Order v2.1", label: "Event checkout (draft)", href: "/e" },
          { id: "r3", fromKind: "ENTITY_VERSION", role: "FIELD", isDraft: false, target: "Order v2.1", label: "Entity version gone (deleted)", href: null },
        ],
        truncated: false,
      },
    });
    render(<UsedByPanel subject={ENTITY} />);
    expect((await screen.findByRole("link", { name: "Event checkout v1.3" })).getAttribute("href")).toBe("/e?version=1.3");
    expect(screen.getByRole("link", { name: "Event checkout (draft)" }).getAttribute("href")).toBe("/e");
    expect(screen.getByText("draft")).toBeDefined();
    expect(screen.getByText("KEY")).toBeDefined();
    // The ghost row is visible but is not a link.
    expect(screen.getByText("Entity version gone (deleted)")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Entity version gone (deleted)" })).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(h.listUsagesAction).toHaveBeenCalledWith({ kind: "entity", entityId: "e1" });
    expect(screen.queryByTestId("used-by-truncated")).toBeNull();
  });

  it("shows the empty and error states", async () => {
    h.listUsagesAction.mockResolvedValueOnce(none);
    render(<UsedByPanel subject={ENTITY} />);
    expect(await screen.findByText("Nothing references this yet.")).toBeDefined();
    cleanup();
    h.listUsagesAction.mockResolvedValueOnce({ success: false, error: "boom" });
    render(<UsedByPanel subject={ENTITY} />);
    expect((await screen.findByRole("alert")).textContent).toBe("boom");
  });

  it("shows the empty text it is given (the event page's own wording)", async () => {
    h.listUsagesAction.mockResolvedValueOnce(none);
    render(<UsedByPanel subject={{ kind: "event", eventId: "ev1" }} emptyText="No other event references this one." />);
    expect(await screen.findByText("No other event references this one.")).toBeDefined();
    expect(screen.queryByText("Nothing references this yet.")).toBeNull();
  });

  it("shows a generic error when the action itself rejects (never hangs on the loading state)", async () => {
    h.listUsagesAction.mockRejectedValueOnce(new Error("network down"));
    render(<UsedByPanel subject={ENTITY} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not load usages. Try again.");
    expect(screen.queryByText(/Looking up references/)).toBeNull();
  });

  it("shows a loading state first and re-queries when the subject changes", async () => {
    h.listUsagesAction.mockResolvedValue(none);
    const { rerender } = render(<UsedByPanel subject={ENTITY} title="Referenced by" />);
    expect(screen.getByText(/Looking up references/)).toBeDefined();
    expect(screen.getByText("Referenced by")).toBeDefined();
    await screen.findByText("Nothing references this yet.");
    rerender(<UsedByPanel subject={{ kind: "entity", entityId: "e2" }} title="Referenced by" />);
    await waitFor(() => expect(h.listUsagesAction).toHaveBeenCalledTimes(2));
    expect(h.listUsagesAction).toHaveBeenLastCalledWith({ kind: "entity", entityId: "e2" });
  });

  it("does not re-query when the parent re-renders with an equal subject object", async () => {
    h.listUsagesAction.mockResolvedValue(none);
    const { rerender } = render(<UsedByPanel subject={ENTITY} />);
    await screen.findByText("Nothing references this yet.");
    rerender(<UsedByPanel subject={{ kind: "entity", entityId: "e1" }} />);
    expect(h.listUsagesAction).toHaveBeenCalledTimes(1);
  });

  it("looks up an event subject, and treats an event and an entity with the same id as different subjects", async () => {
    h.listUsagesAction.mockResolvedValue(none);
    const { rerender } = render(<UsedByPanel subject={{ kind: "event", eventId: "x1" }} />);
    await screen.findByText("Nothing references this yet.");
    expect(h.listUsagesAction).toHaveBeenLastCalledWith({ kind: "event", eventId: "x1" });
    // Same id, other kind: the effect key includes the kind, so this is a new lookup, not a reuse of the event's answer.
    rerender(<UsedByPanel subject={{ kind: "entity", entityId: "x1" }} />);
    await waitFor(() => expect(h.listUsagesAction).toHaveBeenCalledTimes(2));
    expect(h.listUsagesAction).toHaveBeenLastCalledWith({ kind: "entity", entityId: "x1" });
    rerender(<UsedByPanel subject={{ kind: "event", eventId: "x2" }} />);
    await waitFor(() => expect(h.listUsagesAction).toHaveBeenCalledTimes(3));
    expect(h.listUsagesAction).toHaveBeenLastCalledWith({ kind: "event", eventId: "x2" });
  });

  describe("a truncated list", () => {
    const row = { id: "r1", fromKind: "EVENT_SPEC_VERSION", role: "PAYLOAD", isDraft: false, target: "Order v1.0", label: "Event a v1.0", href: "/a" };

    it("says so, below the rows that are shown, with the number of rows it actually shows", async () => {
      // The scan limit can cut the list short of USAGE_ROW_LIMIT: the text counts the rows on screen, never the limit.
      const rows = [row, { ...row, id: "r2", label: "Event b v1.0", href: "/b" }, { ...row, id: "r3", label: "Event c v1.0", href: "/c" }];
      h.listUsagesAction.mockResolvedValue({ success: true, data: { rows, truncated: true } });
      render(<UsedByPanel subject={{ kind: "event", eventId: "ev1" }} />);
      expect(await screen.findByRole("link", { name: "Event a v1.0" })).toBeDefined();
      expect(screen.getAllByRole("link")).toHaveLength(3);
      expect(screen.getByTestId("used-by-truncated").textContent).toBe("Showing the first 3 references.");
      expect(screen.getByTestId("used-by-truncated").textContent).not.toContain(String(USAGE_ROW_LIMIT));
    });

    it("counts a full page as the limit (the common case) and a single row in the singular", async () => {
      const full = Array.from({ length: USAGE_ROW_LIMIT }, (_, i) => ({ ...row, id: `r${i}`, label: `Event ${i} v1.0`, href: `/e${i}` }));
      h.listUsagesAction.mockResolvedValue({ success: true, data: { rows: full, truncated: true } });
      const { unmount } = render(<UsedByPanel subject={{ kind: "event", eventId: "ev1" }} />);
      await screen.findByRole("link", { name: "Event 0 v1.0" });
      expect(screen.getByTestId("used-by-truncated").textContent).toBe("Showing the first 50 references.");
      unmount();
      h.listUsagesAction.mockResolvedValue({ success: true, data: { rows: [row], truncated: true } });
      render(<UsedByPanel subject={{ kind: "event", eventId: "ev1" }} />);
      await screen.findByRole("link", { name: "Event a v1.0" });
      expect(screen.getByTestId("used-by-truncated").textContent).toBe("Showing the first reference.");
    });

    it("says nothing when the list is complete", async () => {
      h.listUsagesAction.mockResolvedValue({ success: true, data: { rows: [row], truncated: false } });
      render(<UsedByPanel subject={{ kind: "event", eventId: "ev1" }} />);
      await screen.findByRole("link", { name: "Event a v1.0" });
      expect(screen.queryByText(/Showing the first/)).toBeNull();
    });
  });
});
