// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), invalidate: vi.fn(), updateMessageAction: vi.fn(), deleteMessageAction: vi.fn() }));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => h.invalidate }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, refresh: h.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-actions", () => ({ updateMessageAction: h.updateMessageAction, deleteMessageAction: h.deleteMessageAction }));
// The picker's default loader: the tenant-scoped action, not the entity workspace's unscoped one.
vi.mock("@/features/events/pin-actions", () => ({
  listPinnableVersionsAction: vi.fn(async (id: string) => ({
    success: true,
    data: id === "e1" ? [{ id: "v21", label: "2.1" }, { id: "v20", label: "2.0" }] : [{ id: "vk", label: "1.0" }],
  })),
}));
import { MessageEditor } from "@/features/events/messages/MessageEditor";

const props = {
  productId: "p1",
  listHref: "/schemas/payments/checkout?tab=events&section=messages",
  entityOptions: [
    { id: "e1", name: "Order", ownerLabel: "Payments / Checkout", latestVersionId: "v21", latestVersionLabel: "2.1" },
    { id: "e2", name: "OrderKey", ownerLabel: "Payments / Checkout", latestVersionId: "vk", latestVersionLabel: "1.0" },
  ],
  traitOptions: [{ id: "t1", name: "CloudEvents", ownerLabel: "Enterprise" }],
  message: {
    id: "m1", name: "OrderCreated", spec: { contentType: "avro/binary", traitIds: [] },
    payload: { entityId: "e1", entityVersionId: "v20" }, headers: null, key: null,
    latestVersionLabel: null, hasUnpublishedChanges: true, tenantId: "t", domainId: "d1", productId: "p1",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.updateMessageAction.mockResolvedValue({ success: true, data: { id: "m1" } });
  h.deleteMessageAction.mockResolvedValue({ success: true, data: { id: "m1" } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MessageEditor", () => {
  it("saves AsyncAPI message fields, pins, traits, bindings and examples", async () => {
    render(<MessageEditor {...props} />);
    expect(await screen.findByTestId("payload-newer")).toBeDefined(); // pinned 2.0, latest 2.1
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "An order was placed" } });
    fireEvent.change(screen.getByLabelText("Correlation ID location"), { target: { value: "$message.header#/ce_id" } });
    fireEvent.change(screen.getByLabelText("Kafka key entity"), { target: { value: "e2" } });
    fireEvent.click(screen.getByLabelText("CloudEvents"));
    fireEvent.change(screen.getByLabelText("Examples"), { target: { value: '[{"payload":{"id":"1"}}]' } });
    fireEvent.click(screen.getByTestId("message-save"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateMessageAction).toHaveBeenCalledWith("m1", "p1", {
      name: "OrderCreated",
      spec: {
        summary: "An order was placed", contentType: "avro/binary", correlationId: { location: "$message.header#/ce_id" },
        examples: [{ payload: { id: "1" } }], traitIds: ["t1"],
      },
      payload: { entityId: "e1", entityVersionId: "v20" },
      headers: null,
      key: { entityId: "e2", entityVersionId: "vk" },
    });
  });

  it("refuses invalid example JSON and shows validation problems from the server", async () => {
    render(<MessageEditor {...props} />);
    fireEvent.change(screen.getByLabelText("Examples"), { target: { value: "{}" } });
    fireEvent.click(screen.getByTestId("message-save"));
    expect(h.updateMessageAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Examples"), { target: { value: "" } });
    h.updateMessageAction.mockResolvedValueOnce({ success: false, error: "bad", code: "VALIDATION_ERROR", details: { problems: ['Trait "x" not found', "Payload: …"] } });
    fireEvent.click(screen.getByTestId("message-save"));
    expect(await screen.findByText('Trait "x" not found')).toBeDefined();
    expect(screen.getByText("Payload: …")).toBeDefined();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  // updateMessage is a FULL REPLACE: an untouched form must send back exactly what it loaded.
  it("round-trips the whole spec and the exact pins when nothing is edited", async () => {
    const spec = {
      title: "Order created", summary: "s", description: "d", contentType: "application/json",
      correlationId: { location: "$message.header#/ce_id", description: "kept" },
      tags: [{ name: "orders" }], externalDocs: { url: "https://example.com/docs" },
      bindings: { kafka: { schemaIdLocation: "header" } }, examples: [{ payload: { id: "1" } }], traitIds: ["t1"],
    };
    const message = { ...props.message, spec, headers: { entityId: "e2", entityVersionId: "vk" }, key: { entityId: "e2", entityVersionId: null } };
    render(<MessageEditor {...props} message={message} />);
    fireEvent.click(screen.getByTestId("message-save"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateMessageAction).toHaveBeenCalledWith("m1", "p1", {
      name: "OrderCreated",
      spec,
      payload: { entityId: "e1", entityVersionId: "v20" }, // not re-pinned to the latest v21
      headers: { entityId: "e2", entityVersionId: "vk" },
      key: { entityId: "e2", entityVersionId: null }, // explicitly unpinned stays unpinned
    });
  });

  it("keeps a stored correlation id that has no location, edits only the location otherwise, and clears it when emptied", async () => {
    const correlationId = { description: "no location yet" };
    const { unmount } = render(<MessageEditor {...props} message={{ ...props.message, spec: { traitIds: [], correlationId } }} />);
    fireEvent.click(screen.getByTestId("message-save"));
    await waitFor(() => expect(h.updateMessageAction).toHaveBeenCalledTimes(1));
    expect(h.updateMessageAction.mock.calls[0][2].spec).toEqual({ traitIds: [], correlationId });
    unmount();

    const withLocation = { location: "$message.header#/a", description: "kept" };
    render(<MessageEditor {...props} message={{ ...props.message, spec: { traitIds: [], correlationId: withLocation } }} />);
    fireEvent.change(screen.getByLabelText("Correlation ID location"), { target: { value: "$message.payload#/id" } });
    fireEvent.click(screen.getByTestId("message-save"));
    await waitFor(() => expect(h.updateMessageAction).toHaveBeenCalledTimes(2));
    expect(h.updateMessageAction.mock.calls[1][2].spec.correlationId).toEqual({ location: "$message.payload#/id", description: "kept" });
    await waitFor(() => expect((screen.getByTestId("message-save") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Correlation ID location"), { target: { value: " " } });
    fireEvent.click(screen.getByTestId("message-save"));
    await waitFor(() => expect(h.updateMessageAction).toHaveBeenCalledTimes(3));
    expect(h.updateMessageAction.mock.calls[2][2].spec).toEqual({ traitIds: [] });
  });

  it("lets the user remove a stored trait the product can no longer see", async () => {
    render(<MessageEditor {...props} message={{ ...props.message, spec: { traitIds: ["gone"] } }} />);
    fireEvent.click(screen.getByLabelText("Unavailable trait gone"));
    expect(screen.queryByLabelText("Unavailable trait gone")).toBeNull();
    fireEvent.click(screen.getByTestId("message-save"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateMessageAction.mock.calls[0][2].spec.traitIds).toEqual([]);
  });

  it("blocks a save while Bindings is not a JSON object", async () => {
    render(<MessageEditor {...props} />);
    fireEvent.change(screen.getByLabelText("Bindings"), { target: { value: "[1]" } });
    fireEvent.click(screen.getByTestId("message-save"));
    expect((await screen.findByTestId("message-error")).textContent).toContain("Bindings must be a JSON object");
    expect(h.updateMessageAction).not.toHaveBeenCalled();
  });

  it("never shows server text for database or internal failures, and still re-enables Save", async () => {
    render(<MessageEditor {...props} />);
    const save = screen.getByTestId("message-save") as HTMLButtonElement;
    // The button is disabled the moment the click is processed and enabled again only once the action has settled.
    const saveAndSettle = async () => {
      fireEvent.click(save);
      expect(save.disabled).toBe(true);
      await waitFor(() => expect(save.disabled).toBe(false));
    };

    h.updateMessageAction.mockResolvedValueOnce({ success: false, error: 'duplicate key value violates unique constraint "messages_pkey"', code: "DB_ERROR" });
    await saveAndSettle();
    expect(screen.getByTestId("message-error").textContent).toContain("Something went wrong");
    expect(screen.getByTestId("message-error").textContent).not.toContain("messages_pkey");

    h.updateMessageAction.mockResolvedValueOnce({ success: false, error: "prisma stack", code: "INTERNAL_ERROR" });
    await saveAndSettle();
    expect(screen.getByTestId("message-error").textContent).toContain("Something went wrong");
    expect(screen.getByTestId("message-error").textContent).not.toContain("prisma stack");

    h.updateMessageAction.mockRejectedValueOnce(new Error("socket hang up"));
    await saveAndSettle();
    expect(screen.getByTestId("message-error").textContent).toContain("Something went wrong");
    expect(screen.getByTestId("message-error").textContent).not.toContain("socket hang up");
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("deletes after confirmation and returns to the list; an IN_USE refusal stays on the page with its fix", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<MessageEditor {...props} />);
    const del = screen.getByTestId("message-delete") as HTMLButtonElement;
    fireEvent.click(del);
    expect(h.deleteMessageAction).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    h.deleteMessageAction.mockResolvedValueOnce({ success: false, error: "pinned by a published spec", code: "IN_USE", suggestedFix: "Delete the event spec first" });
    fireEvent.click(del);
    expect(await screen.findByText("pinned by a published spec")).toBeDefined();
    expect(screen.getByText("Delete the event spec first")).toBeDefined();
    expect(h.push).not.toHaveBeenCalled();

    // Neither a declined confirmation nor a refused delete refreshes the explorer: nothing was deleted.
    expect(h.invalidate).not.toHaveBeenCalled();

    await waitFor(() => expect(del.disabled).toBe(false));
    fireEvent.click(del);
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(props.listHref));
    expect(h.deleteMessageAction).toHaveBeenLastCalledWith("m1", "p1");
    // The explorer's React Query cache only refreshes through invalidate (revalidatePath does not reach it).
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it("does not refresh the explorer after a plain save", async () => {
    render(<MessageEditor {...props} />);
    fireEvent.click(screen.getByTestId("message-save"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});
