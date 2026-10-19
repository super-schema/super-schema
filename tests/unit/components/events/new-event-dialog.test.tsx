// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ createEventAction: vi.fn(), invalidate: vi.fn(), order: [] as string[] }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({ createEventAction: h.createEventAction }));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => h.invalidate }));

import { NewEventDialog } from "@/features/events/workspace/NewEventDialog";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const RAW_DB_TEXT = "Invalid `prisma.eventSpec.create()` invocation in /app/src/services/events/event.service.ts:213 — Can't reach database server at `localhost:5432`";

function setup(props: { open?: boolean } = {}) {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn((id: string) => void h.order.push(`created:${id}`));
  const ui = (open: boolean) => <NewEventDialog productId="p1" open={open} onOpenChange={onOpenChange} onCreated={onCreated} />;
  const view = render(ui(props.open ?? true));
  return { onOpenChange, onCreated, rerenderOpen: (open: boolean) => view.rerender(ui(open)) };
}

const nameInput = () => screen.getByTestId("new-event-name") as HTMLInputElement;
const descriptionInput = () => screen.getByTestId("new-event-description") as HTMLTextAreaElement;
const submitButton = () => screen.getByTestId("new-event-submit") as HTMLButtonElement;
const cancelButton = () => screen.getByTestId("new-event-cancel") as HTMLButtonElement;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const submit = () => fireEvent.submit(screen.getByTestId("new-event-form"));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.invalidate.mockImplementation(() => void h.order.push("invalidate"));
  h.createEventAction.mockResolvedValue({ success: true, data: { id: "ev9" } });
});
afterEach(() => cleanup());

describe("NewEventDialog: content", () => {
  it("renders nothing while closed", () => {
    setup({ open: false });
    expect(screen.queryByTestId("new-event-form")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a labelled dialog with a name, a description and a spec format", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("New Event");
    expect(screen.getByRole("heading", { name: "New Event" })).toBeDefined();
    expect(nameInput().getAttribute("aria-required")).toBe("true");
    expect(screen.getByLabelText("Name")).toBe(nameInput());
    expect(screen.getByLabelText("Description")).toBe(descriptionInput());
    expect(nameInput().value).toBe("");
    expect(descriptionInput().value).toBe("");
  });

  it("offers AsyncAPI 3.0 as the only spec format, selected and enabled", () => {
    setup();
    const group = screen.getByRole("radiogroup", { name: "Spec format" });
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(1);
    expect(radios[0]).toBe(screen.getByTestId("new-event-format-asyncapi"));
    expect(radios[0].checked).toBe(true);
    expect(radios[0].disabled).toBe(false);
    expect(radios[0].value).toBe("asyncapi@3.0");
    expect(group.textContent).toContain("AsyncAPI 3.0");
    // The radio cannot be unchecked by clicking it.
    fireEvent.click(radios[0]);
    expect(radios[0].checked).toBe(true);
  });

  it("tells the user which characters a name may use", () => {
    setup();
    expect(screen.getByTestId("new-event-name-hint").textContent).toMatch(/letters, digits/i);
    expect(nameInput().getAttribute("aria-describedby")).toContain("new-event-name-hint");
  });
});

describe("NewEventDialog: name is required", () => {
  it("shows an inline error linked to the field and calls no action for an empty name", () => {
    setup();
    fireEvent.click(submitButton());
    const error = screen.getByTestId("new-event-name-error");
    expect(error.textContent).toBe("Name is required.");
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(nameInput().getAttribute("aria-describedby")).toContain("new-event-name-error");
    expect(h.createEventAction).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only name as empty", () => {
    setup();
    type(nameInput(), "   ");
    submit();
    expect(screen.getByTestId("new-event-name-error").textContent).toBe("Name is required.");
    expect(h.createEventAction).not.toHaveBeenCalled();
  });

  it("clears the error as soon as the user types a name", () => {
    setup();
    submit();
    expect(screen.getByTestId("new-event-name-error")).toBeDefined();
    type(nameInput(), "o");
    expect(screen.queryByTestId("new-event-name-error")).toBeNull();
    expect(nameInput().getAttribute("aria-invalid")).toBeNull();
  });
});

describe("NewEventDialog: submit", () => {
  it("calls createEventAction with the product id and the trimmed name and description", async () => {
    setup();
    type(nameInput(), "  order-events  ");
    type(descriptionInput(), "  What checkout emits.  ");
    fireEvent.click(submitButton());
    await waitFor(() => expect(h.createEventAction).toHaveBeenCalledTimes(1));
    expect(h.createEventAction).toHaveBeenCalledWith("p1", { name: "order-events", description: "What checkout emits." });
  });

  it("omits an empty description rather than sending an empty string", async () => {
    setup();
    type(nameInput(), "order-events");
    type(descriptionInput(), "   ");
    fireEvent.click(submitButton());
    await waitFor(() => expect(h.createEventAction).toHaveBeenCalledTimes(1));
    const input = h.createEventAction.mock.calls[0][1] as { name: string; description?: string };
    expect(input.name).toBe("order-events");
    expect(input.description).toBeUndefined();
  });

  it("submits on Enter in the name field (a form submit)", async () => {
    setup();
    type(nameInput(), "order-events");
    submit();
    await waitFor(() => expect(h.createEventAction).toHaveBeenCalledTimes(1));
  });

  it("on success invalidates the explorer tree first, then reports the new id", async () => {
    const { onCreated } = setup();
    type(nameInput(), "order-events");
    fireEvent.click(submitButton());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("ev9"));
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(h.invalidate).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual(["invalidate", "created:ev9"]);
  });

  it("does not close the dialog itself on success (the caller navigates away)", async () => {
    const { onCreated, onOpenChange } = setup();
    type(nameInput(), "order-events");
    fireEvent.click(submitButton());
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("NewEventDialog: errors", () => {
  it("shows the service's message and its suggested fix inline and never reports a created event", async () => {
    h.createEventAction.mockResolvedValue({
      success: false, code: "VALIDATION_ERROR", error: 'Event name "a b" is invalid',
      suggestedFix: "Use 1–128 letters, digits, '.', '_' or '-'.",
    });
    const { onCreated } = setup();
    type(nameInput(), "a b");
    fireEvent.click(submitButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe('Event name "a b" is invalid. Use 1–128 letters, digits, \'.\', \'_\' or \'-\'.');
    expect(alert.getAttribute("data-testid")).toBe("new-event-error");
    expect(onCreated).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it("shows a name clash as the service words it", async () => {
    h.createEventAction.mockResolvedValue({
      success: false, code: "NAME_CONFLICT", error: '"orders" is already used by Event "orders" at Product level.', suggestedFix: "Pick another name.",
    });
    setup();
    type(nameInput(), "orders");
    fireEvent.click(submitButton());
    expect((await screen.findByRole("alert")).textContent).toBe('"orders" is already used by Event "orders" at Product level. Pick another name.');
  });

  it("shows the generic message, never the raw text, for a DB_ERROR or INTERNAL_ERROR result", async () => {
    h.createEventAction.mockResolvedValue({ success: false, code: "DB_ERROR", error: RAW_DB_TEXT, suggestedFix: "Check DATABASE_URL" });
    setup();
    type(nameInput(), "orders");
    fireEvent.click(submitButton());
    expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ACTION_ERROR);
    expect(document.body.textContent).not.toMatch(/prisma|database server|localhost|DATABASE_URL/);
    cleanup();

    h.createEventAction.mockResolvedValue({ success: false, code: "INTERNAL_ERROR", error: RAW_DB_TEXT });
    setup();
    type(nameInput(), "orders");
    fireEvent.click(submitButton());
    expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ACTION_ERROR);
    expect(document.body.textContent).not.toMatch(/prisma|database server/);
  });

  it("shows the generic message when the action throws, and the form can be submitted again", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    h.createEventAction.mockRejectedValueOnce(new Error(RAW_DB_TEXT));
    const { onCreated } = setup();
    type(nameInput(), "orders");
    fireEvent.click(submitButton());
    expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ACTION_ERROR);
    expect(document.body.textContent).not.toMatch(/prisma|database server/);
    expect(onCreated).not.toHaveBeenCalled();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    expect(cancelButton().disabled).toBe(false);
    // A retry works and clears the error.
    fireEvent.click(submitButton());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("ev9"));
    expect(screen.queryByRole("alert")).toBeNull();
    consoleError.mockRestore();
  });

  it("keeps what the user typed after a failure", async () => {
    h.createEventAction.mockResolvedValue({ success: false, code: "NAME_CONFLICT", error: "taken" });
    setup();
    type(nameInput(), "orders");
    type(descriptionInput(), "Order events");
    fireEvent.click(submitButton());
    await screen.findByRole("alert");
    expect(nameInput().value).toBe("orders");
    expect(descriptionInput().value).toBe("Order events");
  });
});

describe("NewEventDialog: single flight", () => {
  it("ignores a second submit while the first is in flight and disables the buttons meanwhile", async () => {
    const pending = deferred<{ success: true; data: { id: string } }>();
    h.createEventAction.mockReturnValue(pending.promise);
    const { onCreated } = setup();
    type(nameInput(), "orders");
    fireEvent.click(submitButton());
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().textContent).toBe("Creating…");
    expect(cancelButton().disabled).toBe(true);
    // Enter in a field submits the form without going through the disabled button.
    submit();
    submit();
    expect(h.createEventAction).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ success: true, data: { id: "ev9" } }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("ev9"));
    expect(h.createEventAction).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("stays busy after a successful create so the user cannot create a duplicate while the page navigates", async () => {
    const { onCreated } = setup();
    type(nameInput(), "orders");
    fireEvent.click(submitButton());
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(submitButton().disabled).toBe(true);
    expect(cancelButton().disabled).toBe(true);
    submit();
    fireEvent.click(submitButton());
    expect(h.createEventAction).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });
});

describe("NewEventDialog: closing", () => {
  it("Cancel asks the host to close and calls no action", () => {
    const { onOpenChange } = setup();
    type(nameInput(), "orders");
    fireEvent.click(cancelButton());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(h.createEventAction).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it("starts empty again when it is reopened, without the previous error", async () => {
    h.createEventAction.mockResolvedValue({ success: false, code: "NAME_CONFLICT", error: "taken" });
    const { rerenderOpen } = setup();
    type(nameInput(), "orders");
    type(descriptionInput(), "Order events");
    submit();
    await screen.findByRole("alert");
    rerenderOpen(false);
    await waitFor(() => expect(screen.queryByTestId("new-event-form")).toBeNull());
    rerenderOpen(true);
    expect(nameInput().value).toBe("");
    expect(descriptionInput().value).toBe("");
    expect(screen.queryByTestId("new-event-name-error")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
