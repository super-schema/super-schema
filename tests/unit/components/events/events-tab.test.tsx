// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ push: vi.fn(), createChannelAction: vi.fn(), createMessageAction: vi.fn(), createEventSpecAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channel-actions", () => ({ createChannelAction: h.createChannelAction }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-actions", () => ({ createMessageAction: h.createMessageAction }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-actions", () => ({ createEventSpecAction: h.createEventSpecAction }));

import { EventsTab } from "@/features/events/workspace/EventsTab";
import type { EventsTabData } from "@/features/events/workspace/types";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const data: EventsTabData = {
  eventSpecs: [{ id: "s1", name: "checkout-service", summary: "", updatedAt: "", latestVersionLabel: "2.0", hasUnpublishedChanges: true, operationCount: 1, href: "/schemas/payments/checkout/specs/s1" }],
  messages: [],
  channels: [{ id: "c1", name: "orders", summary: "Orders topic", updatedAt: "", address: "payments.orders.v1", protocol: "kafka", format: "avro", href: "/schemas/payments/checkout/channels/c1" }],
  payloadEntities: [{ id: "e1", name: "Order", ownerLabel: "Payments / Checkout", latestVersionId: "v1", latestVersionLabel: "1.0" }],
};

function renderTab(props: Partial<Parameters<typeof EventsTab>[0]> = {}) {
  const onSectionChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EventsTab productId="p1" domainSlug="payments" productSlug="checkout" data={data} section="specs" onSectionChange={onSectionChange} {...props} />
    </QueryClientProvider>
  );
  return { onSectionChange };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => cleanup());

describe("EventsTab", () => {
  it("lists the selected section with canonical links, badges and counts", () => {
    const { onSectionChange } = renderTab();
    expect(screen.getByRole("link", { name: /checkout-service/ }).getAttribute("href")).toBe("/schemas/payments/checkout/specs/s1");
    expect(screen.getByText("v2.0")).toBeDefined();
    expect(screen.getByText("unpublished changes")).toBeDefined();
    fireEvent.click(screen.getByTestId("events-section-channels"));
    expect(onSectionChange).toHaveBeenCalledWith("channels");
  });

  it("shows an empty state per section", () => {
    renderTab({ section: "messages" });
    expect(screen.getByTestId("events-messages-empty")).toBeDefined();
  });

  it("lists channels and messages with their own metadata", () => {
    renderTab({ section: "channels" });
    expect(screen.getByRole("link", { name: /orders/ }).getAttribute("href")).toBe("/schemas/payments/checkout/channels/c1");
    expect(screen.getByText("kafka")).toBeDefined();
    expect(screen.getByText("avro")).toBeDefined();
    cleanup();

    renderTab({
      section: "messages",
      data: { ...data, messages: [{ id: "m1", name: "OrderCreated", summary: "", updatedAt: "", latestVersionLabel: null, hasUnpublishedChanges: true, payloadEntityName: "Order", href: "/schemas/payments/checkout/messages/m1" }] },
    });
    expect(screen.getByText("unpublished")).toBeDefined();
    // A never-published item has no "unpublished changes" badge on top of the "unpublished" one.
    expect(screen.queryByText("unpublished changes")).toBeNull();
    expect(screen.getByText("Order")).toBeDefined();
  });

  it("creates a channel from the New menu intent and opens it", async () => {
    h.createChannelAction.mockResolvedValue({ success: true, data: { id: "c9" } });
    const onCreateIntentConsumed = vi.fn();
    const { onSectionChange } = renderTab({ createIntent: "channel", onCreateIntentConsumed });
    expect(onSectionChange).toHaveBeenCalledWith("channels");
    expect(onCreateIntentConsumed).toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Channel name"), { target: { value: "refunds" } });
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "payments.refunds.v1" } });
    fireEvent.change(screen.getByLabelText("Format"), { target: { value: "json-schema" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/schemas/payments/checkout/channels/c9"));
    expect(h.createChannelAction).toHaveBeenCalledWith("p1", { name: "refunds", address: "payments.refunds.v1", protocol: "kafka", format: "json-schema", formatDialect: "draft-07" });
  });

  it("creates a message (payload pinned to the latest version server-side) and an event spec; shows errors", async () => {
    h.createMessageAction.mockResolvedValue({ success: false, error: '"OrderCreated" is already used by Entity "OrderCreated" at Product level.' });
    renderTab({ createIntent: "message" });
    fireEvent.change(screen.getByLabelText("Message name"), { target: { value: "OrderCreated" } });
    fireEvent.change(screen.getByLabelText("Payload entity"), { target: { value: "e1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already used/);
    expect(h.createMessageAction).toHaveBeenCalledWith("p1", { name: "OrderCreated", payload: { entityId: "e1" } });
    cleanup();

    h.createEventSpecAction.mockResolvedValue({ success: true, data: { id: "s9" } });
    renderTab({ createIntent: "eventSpec" });
    fireEvent.change(screen.getByLabelText("Event spec name"), { target: { value: "checkout-service-v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/schemas/payments/checkout/specs/s9"));
    expect(h.createEventSpecAction).toHaveBeenCalledWith("p1", { name: "checkout-service-v2", title: undefined });
  });

  it("shows the service's suggested fix under a failed create and never navigates", async () => {
    h.createEventSpecAction.mockResolvedValue({ success: false, code: "VALIDATION_ERROR", error: 'Event spec name "a b" is invalid', suggestedFix: "Use 1–128 letters, digits, '.', '_' or '-'." });
    renderTab({ createIntent: "eventSpec" });
    fireEvent.change(screen.getByLabelText("Event spec name"), { target: { value: "a b" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/is invalid/);
    expect(alert.textContent).toMatch(/letters, digits/);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("cancels a form without calling any action", () => {
    renderTab({ createIntent: "channel" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("new-channel-form")).toBeNull();
    expect(h.createChannelAction).not.toHaveBeenCalled();
  });

  it("the section's own New button opens the matching form", () => {
    renderTab({ section: "channels" });
    fireEvent.click(screen.getByTestId("events-new"));
    expect(screen.getByTestId("new-channel-form")).toBeDefined();
  });
});

describe("EventsTab create forms — error display and submit guard", () => {
  const RAW_DB_TEXT = "Invalid `prisma.channel.create()` invocation in /app/src/services/events/channel.service.ts:88 — Can't reach database server at `localhost:5432`";

  function submitChannelForm(name = "refunds") {
    renderTab({ createIntent: "channel" });
    fireEvent.change(screen.getByLabelText("Channel name"), { target: { value: name } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
  }

  it("shows the generic message, never the raw text, for a DB_ERROR result", async () => {
    h.createChannelAction.mockResolvedValue({ success: false, code: "DB_ERROR", error: RAW_DB_TEXT, suggestedFix: "Check DATABASE_URL" });
    submitChannelForm();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(GENERIC_ACTION_ERROR);
    expect(document.body.textContent).not.toMatch(/prisma|database server|localhost|DATABASE_URL/);
    // A failure makes the form editable again.
    expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(false);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("shows the generic message for an INTERNAL_ERROR result on every create form", async () => {
    h.createMessageAction.mockResolvedValue({ success: false, code: "INTERNAL_ERROR", error: RAW_DB_TEXT });
    renderTab({ createIntent: "message" });
    fireEvent.change(screen.getByLabelText("Message name"), { target: { value: "OrderCreated" } });
    fireEvent.change(screen.getByLabelText("Payload entity"), { target: { value: "e1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ACTION_ERROR);
    cleanup();

    h.createEventSpecAction.mockResolvedValue({ success: false, code: "DB_ERROR", error: RAW_DB_TEXT });
    renderTab({ createIntent: "eventSpec" });
    fireEvent.change(screen.getByLabelText("Event spec name"), { target: { value: "checkout-service" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ACTION_ERROR);
    expect(document.body.textContent).not.toMatch(/prisma|database server/);
  });

  it("shows the generic message when the action throws, and the form is not left busy", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    h.createChannelAction.mockRejectedValue(new Error(RAW_DB_TEXT));
    submitChannelForm();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(GENERIC_ACTION_ERROR);
    expect(document.body.textContent).not.toMatch(/prisma|database server/);
    const create = screen.getByRole("button", { name: "Create" });
    expect(create.hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(false);
    expect(h.push).not.toHaveBeenCalled();
    // And it can be submitted again.
    h.createChannelAction.mockResolvedValue({ success: true, data: { id: "c9" } });
    fireEvent.click(create);
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/schemas/payments/checkout/channels/c9"));
    consoleError.mockRestore();
  });

  it("still shows a non-DB error's message and its suggested fix (NAME_CONFLICT)", async () => {
    h.createChannelAction.mockResolvedValue({
      success: false, code: "NAME_CONFLICT", error: '"refunds" is already used by Channel "refunds" at Product level.', suggestedFix: "Pick another name.",
    });
    submitChannelForm();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe('"refunds" is already used by Channel "refunds" at Product level. Pick another name.');
  });

  it("stays busy after a successful create: Create is disabled and a second submit does not call the action again", async () => {
    h.createChannelAction.mockResolvedValue({ success: true, data: { id: "c9" } });
    submitChannelForm();
    await waitFor(() => expect(h.push).toHaveBeenCalledTimes(1));
    const create = screen.getByRole("button", { name: "Creating…" });
    expect(create.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(create);
    fireEvent.submit(screen.getByTestId("new-channel-form"));
    expect(h.createChannelAction).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it("ignores a second submit while the first is still in flight", async () => {
    let finish: (r: { success: true; data: { id: string } }) => void = () => {};
    h.createChannelAction.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    submitChannelForm();
    const form = screen.getByTestId("new-channel-form");
    expect(screen.getByRole("button", { name: "Creating…" }).hasAttribute("disabled")).toBe(true);
    // Enter in a field submits the form without going through the disabled button.
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(h.createChannelAction).toHaveBeenCalledTimes(1);
    finish({ success: true, data: { id: "c9" } });
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/schemas/payments/checkout/channels/c9"));
    expect(h.createChannelAction).toHaveBeenCalledTimes(1);
  });
});

describe("EventsTab section tabs — keyboard and roving tabindex", () => {
  const tab = (id: string) => screen.getByTestId(`events-section-${id}`);

  function renderSections(section: "specs" | "messages" | "channels") {
    const onSectionChange = vi.fn();
    const ui = (s: typeof section) => (
      <QueryClientProvider client={new QueryClient()}>
        <EventsTab productId="p1" domainSlug="payments" productSlug="checkout" data={data} section={s} onSectionChange={onSectionChange} />
      </QueryClientProvider>
    );
    const view = render(ui(section));
    return { onSectionChange, rerenderAt: (s: typeof section) => view.rerender(ui(s)) };
  }

  it("only the selected section is in the tab order and the tabs are wired to the panel", () => {
    const { rerenderAt } = renderSections("specs");
    expect(["specs", "messages", "channels"].map((id) => tab(id).getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("events-tab-specs");
    expect(tab("specs").getAttribute("aria-controls")).toBe(screen.getByRole("tabpanel").id);
    rerenderAt("channels");
    expect(["specs", "messages", "channels"].map((id) => tab(id).getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("events-tab-channels");
  });

  it("ArrowRight / ArrowLeft move to the neighbouring section, wrap around, and move focus", () => {
    const { onSectionChange } = renderSections("specs");
    fireEvent.keyDown(tab("specs"), { key: "ArrowRight" });
    expect(onSectionChange).toHaveBeenLastCalledWith("messages");
    expect(document.activeElement).toBe(tab("messages"));

    fireEvent.keyDown(tab("channels"), { key: "ArrowRight" });
    expect(onSectionChange).toHaveBeenLastCalledWith("specs");
    expect(document.activeElement).toBe(tab("specs"));

    fireEvent.keyDown(tab("specs"), { key: "ArrowLeft" });
    expect(onSectionChange).toHaveBeenLastCalledWith("channels");
    expect(document.activeElement).toBe(tab("channels"));

    fireEvent.keyDown(tab("channels"), { key: "ArrowLeft" });
    expect(onSectionChange).toHaveBeenLastCalledWith("messages");
    expect(document.activeElement).toBe(tab("messages"));
  });

  it("Home and End jump to the first and last section", () => {
    const { onSectionChange } = renderSections("messages");
    fireEvent.keyDown(tab("messages"), { key: "End" });
    expect(onSectionChange).toHaveBeenLastCalledWith("channels");
    expect(document.activeElement).toBe(tab("channels"));
    fireEvent.keyDown(tab("channels"), { key: "Home" });
    expect(onSectionChange).toHaveBeenLastCalledWith("specs");
    expect(document.activeElement).toBe(tab("specs"));
  });

  it("keys that are not tab navigation do nothing", () => {
    const { onSectionChange } = renderSections("specs");
    fireEvent.keyDown(tab("specs"), { key: "ArrowDown" });
    fireEvent.keyDown(tab("specs"), { key: "a" });
    expect(onSectionChange).not.toHaveBeenCalled();
  });
});
