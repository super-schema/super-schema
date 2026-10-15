// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions", () => ({ listEntityVersionsAction: vi.fn() }));
import { EntityPinPicker, type EntityOption } from "@/features/events/shared/EntityPinPicker";

afterEach(() => cleanup());
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
});
