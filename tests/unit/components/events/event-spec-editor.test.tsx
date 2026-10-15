// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ updateEventSpecDocumentAction: vi.fn(), renameEventSpecAction: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-actions", () => ({
  updateEventSpecDocumentAction: h.updateEventSpecDocumentAction, renameEventSpecAction: h.renameEventSpecAction,
}));
import { EventSpecEditor } from "@/features/events/event-specs/EventSpecEditor";

const spec = {
  id: "s1", name: "checkout-service", specType: "asyncapi@3.0", latestVersionLabel: null, hasUnpublishedChanges: true,
  tenantId: "t", domainId: "d1", productId: "p1",
  document: { info: { title: "checkout-service" }, servers: [], operations: [] },
};
const props = {
  spec,
  productId: "p1",
  channelOptions: [
    { id: "c1", name: "orders", address: "payments.orders.v1", protocol: "kafka", format: "avro", ownerLabel: "Payments / Checkout", own: true, allowedMessageIds: ["m1"] },
    { id: "c2", name: "risk", address: "risk.v1", protocol: "kafka", format: "json-schema", ownerLabel: "Risk / Fraud", own: false, allowedMessageIds: [] },
  ],
  messageOptions: [
    { id: "mv1", messageId: "m1", label: "OrderCreated v1.0", ownerLabel: "Payments / Checkout", own: true, draft: false },
    { id: "m2", messageId: "m2", label: "OrderCancelled (draft — preview only)", ownerLabel: "This product", own: true, draft: true },
  ],
  operationTraits: [{ id: "t1", name: "Retry", ownerLabel: "Enterprise" }],
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("EventSpecEditor", () => {
  it("builds info, a server and an operation, then saves the EventSpecDocument", async () => {
    const onSaved = vi.fn();
    h.updateEventSpecDocumentAction.mockResolvedValue({ success: true, data: { ...spec, hasUnpublishedChanges: true } });
    render(<EventSpecEditor {...props} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Checkout events" } });
    fireEvent.click(screen.getByTestId("spec-add-server"));
    const server = screen.getByTestId("spec-server-0");
    fireEvent.change(within(server).getByLabelText("Key"), { target: { value: "kafka-prod" } });
    fireEvent.change(within(server).getByLabelText("Protocol"), { target: { value: "kafka" } });
    fireEvent.change(within(server).getByLabelText("Host"), { target: { value: "kafka-prod.internal:9092" } });
    fireEvent.click(screen.getByTestId("spec-add-operation"));
    const op = screen.getByTestId("spec-operation-0");
    fireEvent.change(within(op).getByLabelText("Key"), { target: { value: "publishOrderCreated" } });
    fireEvent.change(within(op).getByLabelText("Channel"), { target: { value: "c1" } });
    expect(within(op).getByText("allowed on channel")).toBeDefined();
    fireEvent.click(within(op).getByLabelText("OrderCreated v1.0"));
    fireEvent.click(within(op).getByLabelText("Retry"));
    fireEvent.click(screen.getByTestId("spec-save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(h.updateEventSpecDocumentAction).toHaveBeenCalledWith("s1", "p1", {
      info: { title: "checkout-service", description: "Checkout events" },
      servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
      operations: [{ key: "publishOrderCreated", action: "send", channelId: "c1", messageVersionIds: ["mv1"], traitIds: ["t1"] }],
    });
    expect(h.renameEventSpecAction).not.toHaveBeenCalled();
  });

  it("shows pointer-addressed validation problems from the server", async () => {
    h.updateEventSpecDocumentAction.mockResolvedValue({
      success: false, error: "The event spec document has 1 problem(s)", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/operations/0/channelId", message: "Operation channel is required" }] },
    });
    render(<EventSpecEditor {...props} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId("spec-save"));
    expect(await screen.findByText("/operations/0/channelId: Operation channel is required")).toBeDefined();
  });

  it("renames first and stops, with the rename error, when the rename fails", async () => {
    h.renameEventSpecAction.mockResolvedValue({ success: false, error: 'An event spec named "orders" already exists', code: "CONFLICT" });
    render(<EventSpecEditor {...props} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Spec name"), { target: { value: "orders" } });
    fireEvent.click(screen.getByTestId("spec-save"));
    expect(await screen.findByText('An event spec named "orders" already exists')).toBeDefined();
    expect(h.renameEventSpecAction).toHaveBeenCalledWith("s1", "p1", "orders");
    expect(h.updateEventSpecDocumentAction).not.toHaveBeenCalled();
  });

  it("never prints raw database text: DB_ERROR / INTERNAL_ERROR results show the generic message", async () => {
    h.updateEventSpecDocumentAction.mockResolvedValue({ success: false, error: 'relation "event_specs" does not exist', code: "DB_ERROR" });
    render(<EventSpecEditor {...props} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId("spec-save"));
    expect(await screen.findByText(/Something went wrong/)).toBeDefined();
    expect(screen.queryByText(/relation/)).toBeNull();
  });

  it("ignores malformed problem lists instead of crashing", async () => {
    h.updateEventSpecDocumentAction.mockResolvedValue({
      success: false, error: "The event spec document has problems", code: "VALIDATION_ERROR",
      details: { problems: [null, 3, { pointer: 7 }, { pointer: "/info/title", message: "Title is required" }] },
    });
    render(<EventSpecEditor {...props} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId("spec-save"));
    expect(await screen.findByText("/info/title: Title is required")).toBeDefined();
  });

  it("keeps fields it does not render (bindings, reply, components) when saving", async () => {
    h.updateEventSpecDocumentAction.mockResolvedValue({ success: true, data: spec });
    const rich = {
      ...spec,
      document: {
        info: { title: "x", description: "kept" },
        defaultContentType: "application/json",
        servers: [{ key: "k", protocol: "kafka", host: "h:1", description: "kept too" }],
        operations: [{ key: "op", action: "receive" as const, channelId: "c1", messageVersionIds: [], traitIds: [], bindings: { kafka: { groupId: "g" } }, reply: { channelId: "c2" } }],
        components: { securitySchemes: { s: { type: "plain" } } },
      },
    };
    render(<EventSpecEditor {...props} spec={rich} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId("spec-save"));
    await waitFor(() => expect(h.updateEventSpecDocumentAction).toHaveBeenCalled());
    expect(h.updateEventSpecDocumentAction).toHaveBeenCalledWith("s1", "p1", rich.document);
  });

  it("lists references to deleted messages / traits so they can be removed", async () => {
    h.updateEventSpecDocumentAction.mockResolvedValue({ success: true, data: spec });
    const stale = {
      ...spec,
      document: {
        info: { title: "x" }, servers: [],
        operations: [{ key: "op", action: "send" as const, channelId: "c1", messageVersionIds: ["mv1", "gone-m"], traitIds: ["t1", "gone-t"] }],
      },
    };
    render(<EventSpecEditor {...props} spec={stale} onSaved={vi.fn()} />);
    const op = screen.getByTestId("spec-operation-0");
    const goneMessage = within(op).getByLabelText(/Unavailable message \(gone-m\)/) as HTMLInputElement;
    const goneTrait = within(op).getByLabelText(/Unavailable trait \(gone-t\)/) as HTMLInputElement;
    expect(goneMessage.checked).toBe(true);
    fireEvent.click(goneMessage);
    fireEvent.click(goneTrait);
    fireEvent.click(screen.getByTestId("spec-save"));
    await waitFor(() => expect(h.updateEventSpecDocumentAction).toHaveBeenCalled());
    expect(h.updateEventSpecDocumentAction).toHaveBeenCalledWith("s1", "p1", expect.objectContaining({
      operations: [expect.objectContaining({ messageVersionIds: ["mv1"], traitIds: ["t1"] })],
    }));
  });

  it("flags a channel that no longer exists instead of silently showing the placeholder", () => {
    const stale = {
      ...spec,
      document: { info: { title: "x" }, servers: [], operations: [{ key: "op", action: "send" as const, channelId: "gone-c", messageVersionIds: [], traitIds: [] }] },
    };
    render(<EventSpecEditor {...props} spec={stale} onSaved={vi.fn()} />);
    const select = within(screen.getByTestId("spec-operation-0")).getByLabelText("Channel") as HTMLSelectElement;
    expect(select.value).toBe("gone-c");
    expect(within(select).getByText(/Unavailable channel/)).toBeDefined();
  });
});
