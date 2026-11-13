// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ listPinnableVersionsAction: vi.fn() }));
vi.mock("@/features/events/pin-actions", () => ({ listPinnableVersionsAction: h.listPinnableVersionsAction }));
import { EntityPinPicker, PAGE_SIZE, type EntityOption } from "@/features/events/shared/EntityPinPicker";
import { entityOptionNames, entityValue, pickEntity } from "./helpers/pick-entity";

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
    pickEntity("Payload", "e1");
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
    pickEntity("Headers", "");
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

  describe("search, scope and paging", () => {
    const scope = { domainId: "d1", productId: "p1" };
    const scoped: EntityOption[] = [
      { id: "a", name: "Account", ownerLabel: "Identity / Accounts", domainId: "d1", productId: "p1", latestVersionId: null, latestVersionLabel: null },
      { id: "b", name: "Profile", ownerLabel: "Identity / Profiles", domainId: "d1", productId: "p2", latestVersionId: null, latestVersionLabel: null },
      { id: "c", name: "Invoice", ownerLabel: "Billing / Invoices", domainId: "d2", productId: "p3", latestVersionId: null, latestVersionLabel: null },
    ];
    it("starts on the event's product and widens to the domain or the whole tenant", () => {
      render(<EntityPinPicker id="payload" label="Payload" entities={scoped} scope={scope} value={null} onChange={vi.fn()} loadVersions={loadVersions} />);
      expect(entityOptionNames("Payload")).toEqual(["Account"]);
      fireEvent.click(screen.getByRole("radio", { name: /This domain/ }));
      expect(entityOptionNames("Payload")).toEqual(["Account", "Profile"]);
      fireEvent.click(screen.getByRole("radio", { name: /All/ }));
      expect(entityOptionNames("Payload")).toEqual(["Account", "Profile", "Invoice"]);
    });
    it("searches by name or owner and offers a wider scope when nothing matches here", () => {
      const onChange = vi.fn();
      render(<EntityPinPicker id="payload" label="Payload" entities={scoped} scope={scope} value={null} onChange={onChange} loadVersions={loadVersions} />);
      fireEvent.click(screen.getByLabelText("Payload entity"));
      fireEvent.change(screen.getByRole("searchbox", { name: "Search payload entities" }), { target: { value: "inv" } });
      expect(screen.getByText(/No entities match/)).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "1 in all" }));
      expect(entityOptionNames("Payload")).toEqual(["Invoice"]);
      fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
      expect(onChange).toHaveBeenCalledWith({ entityId: "c", entityVersionId: null });
    });
    it("opens on the narrowest scope that shows the selected entity", () => {
      render(<EntityPinPicker id="payload" label="Payload" entities={scoped} scope={scope} value={{ entityId: "c", entityVersionId: null }} onChange={vi.fn()} loadVersions={loadVersions} />);
      expect(entityValue("Payload")).toBe("c");
      fireEvent.click(screen.getByLabelText("Payload entity"));
      expect(screen.getByRole("radio", { name: /All/ }).getAttribute("aria-checked")).toBe("true");
    });
    it("renders the first page of a long list and loads more on demand", () => {
      const many: EntityOption[] = Array.from({ length: PAGE_SIZE * 2 + 5 }, (_, i) => ({ id: `m${i}`, name: `Entity ${String(i).padStart(3, "0")}`, ownerLabel: "Enterprise", latestVersionId: null, latestVersionLabel: null }));
      render(<EntityPinPicker id="payload" label="Payload" entities={many} value={null} onChange={vi.fn()} loadVersions={loadVersions} />);
      expect(entityOptionNames("Payload")).toHaveLength(PAGE_SIZE);
      expect(screen.getByTestId("payload-entity-count").textContent).toBe(`Showing ${PAGE_SIZE} of ${many.length}`);
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      expect(entityOptionNames("Payload")).toHaveLength(PAGE_SIZE * 2);
    });
  });
});
