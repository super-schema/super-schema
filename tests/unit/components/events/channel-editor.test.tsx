// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  push: vi.fn(), refresh: vi.fn(), invalidate: vi.fn(), toastSuccess: vi.fn(),
  updateChannelAction: vi.fn(), setChannelMessagesAction: vi.fn(), deleteChannelAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, refresh: h.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, error: vi.fn() } }));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => h.invalidate }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channel-actions", () => ({
  updateChannelAction: h.updateChannelAction, setChannelMessagesAction: h.setChannelMessagesAction, deleteChannelAction: h.deleteChannelAction,
}));
import { ChannelEditor } from "@/features/events/channels/ChannelEditor";
import { GENERIC_ACTION_ERROR } from "@/lib/action-error";

const props = {
  productId: "p1",
  listHref: "/schemas/payments/checkout?tab=events&section=channels",
  crumbs: [{ label: "Channels", href: "/x" }, { label: "orders" }],
  messageOptions: [{ id: "m1", name: "OrderCreated", ownerLabel: "Payments / Checkout" }, { id: "m2", name: "Refund", ownerLabel: "Billing / Ledger" }],
  channel: {
    id: "c1", name: "orders", address: "payments.orders.v1", protocol: "kafka", format: "avro" as const, formatDialect: null,
    spec: { summary: "Orders", bindings: { kafka: { partitions: 12 } } }, allowedMessageIds: ["m1"],
    tenantId: "t", domainId: "d1", productId: "p1",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.updateChannelAction.mockResolvedValue({ success: true, data: { id: "c1" } });
  h.setChannelMessagesAction.mockResolvedValue({ success: true, data: { id: "c1" } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChannelEditor", () => {
  it("saves the channel and the changed allow-list", async () => {
    render(<ChannelEditor {...props} />);
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "payments.orders.v2" } });
    fireEvent.change(screen.getByLabelText("Format"), { target: { value: "json-schema" } });
    fireEvent.click(screen.getByLabelText("Refund"));
    fireEvent.click(screen.getByTestId("channel-save"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateChannelAction).toHaveBeenCalledWith("c1", "p1", {
      name: "orders", address: "payments.orders.v2", protocol: "kafka", format: "json-schema", formatDialect: "draft-07",
      spec: { summary: "Orders", bindings: { kafka: { partitions: 12 } } },
    });
    expect(h.setChannelMessagesAction).toHaveBeenCalledWith("c1", "p1", ["m1", "m2"]);
    expect(h.toastSuccess).toHaveBeenCalledWith("Channel saved");
  });

  it("does not touch the allow-list when it is unchanged, and drops the dialect for non JSON Schema formats", async () => {
    render(<ChannelEditor {...props} />);
    expect(screen.queryByLabelText("Dialect")).toBeNull();
    fireEvent.click(screen.getByTestId("channel-save"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateChannelAction.mock.calls[0][2]).toMatchObject({ format: "avro", formatDialect: null });
    expect(h.setChannelMessagesAction).not.toHaveBeenCalled();
  });

  it("round-trips the spec fields the form has no input for (tags, externalDocs, parameters)", async () => {
    const spec = { summary: "Orders", tags: [{ name: "core" }], externalDocs: { url: "https://x.test" }, parameters: { region: { description: "r" } } };
    render(<ChannelEditor {...props} channel={{ ...props.channel, spec }} />);
    fireEvent.click(screen.getByTestId("channel-save"));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateChannelAction.mock.calls[0][2].spec).toEqual(spec);
  });

  it("blocks saving invalid bindings JSON and shows server errors", async () => {
    render(<ChannelEditor {...props} />);
    fireEvent.change(screen.getByLabelText("Bindings"), { target: { value: "{" } });
    fireEvent.click(screen.getByTestId("channel-save"));
    expect((await screen.findByTestId("channel-error")).textContent).toMatch(/Bindings is not valid JSON/);
    expect(h.updateChannelAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Bindings"), { target: { value: "" } });
    h.updateChannelAction.mockResolvedValueOnce({
      success: false, error: '"orders" is already used by Entity "Orders" at Product level.', code: "CONFLICT", suggestedFix: "Choose another name.",
    });
    fireEvent.click(screen.getByTestId("channel-save"));
    const alert = await screen.findByTestId("channel-error");
    expect(alert.textContent).toMatch(/already used/);
    expect(alert.textContent).toMatch(/Choose another name/);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("never shows database error text (DB_ERROR / INTERNAL_ERROR / a rejected action all render the generic message)", async () => {
    render(<ChannelEditor {...props} />);
    const raw = 'duplicate key value violates unique constraint "channels_pkey"';
    for (const code of ["DB_ERROR", "INTERNAL_ERROR"]) {
      h.updateChannelAction.mockResolvedValueOnce({ success: false, error: raw, code });
      fireEvent.click(screen.getByTestId("channel-save"));
      await waitFor(() => expect(screen.getByTestId("channel-error").textContent).toBe(GENERIC_ACTION_ERROR));
    }
    h.updateChannelAction.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    fireEvent.click(screen.getByTestId("channel-save"));
    await waitFor(() => expect(screen.getByTestId("channel-error").textContent).toBe(GENERIC_ACTION_ERROR));
    expect(document.body.textContent).not.toMatch(/ECONNREFUSED|channels_pkey/);
    expect((screen.getByTestId("channel-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("reports a failed allow-list update after the channel itself saved, and refreshes so the page shows the saved channel", async () => {
    h.setChannelMessagesAction.mockResolvedValue({ success: false, error: "Unknown message(s): m2", code: "VALIDATION_ERROR" });
    render(<ChannelEditor {...props} />);
    fireEvent.click(screen.getByLabelText("Refund"));
    fireEvent.click(screen.getByTestId("channel-save"));
    const alert = await screen.findByTestId("channel-error");
    expect(alert.textContent).toMatch(/Channel saved, but the allowed messages were not updated/);
    expect(alert.textContent).toMatch(/Unknown message\(s\): m2/);
    expect(h.refresh).toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it("does not update the allow-list when the channel save fails", async () => {
    h.updateChannelAction.mockResolvedValue({ success: false, error: "read-only", code: "FORBIDDEN" });
    render(<ChannelEditor {...props} />);
    fireEvent.click(screen.getByLabelText("Refund"));
    fireEvent.click(screen.getByTestId("channel-save"));
    expect((await screen.findByTestId("channel-error")).textContent).toMatch(/read-only/);
    expect(h.setChannelMessagesAction).not.toHaveBeenCalled();
  });

  it("deletes after confirmation and returns to the list", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    h.deleteChannelAction.mockResolvedValue({ success: true, data: { id: "c1" } });
    render(<ChannelEditor {...props} />);
    fireEvent.click(screen.getByTestId("channel-delete"));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(props.listHref));
    expect(h.deleteChannelAction).toHaveBeenCalledWith("c1", "p1");
    expect((screen.getByTestId("channel-delete") as HTMLButtonElement).disabled).toBe(true);
    // The explorer's React Query cache only refreshes through invalidate (revalidatePath does not reach it).
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the delete confirmation is declined, and stays on the page when the delete fails", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ChannelEditor {...props} />);
    fireEvent.click(screen.getByTestId("channel-delete"));
    expect(h.deleteChannelAction).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    h.deleteChannelAction.mockResolvedValue({ success: false, error: "In use", code: "IN_USE" });
    fireEvent.click(screen.getByTestId("channel-delete"));
    expect((await screen.findByTestId("channel-error")).textContent).toMatch(/In use/);
    expect(h.push).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});
