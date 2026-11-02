/**
 * The Field Studio's autosave queue: a refused or failed save shows an error and the next edit (or Retry, or Done) sends the change
 * again; an edit made while a save is in flight is sent after it and "Saved" shows only once every edit is persisted; leaving the page
 * sends a pending edit at once and reports a save that is refused; a server refresh with new decorators sends the pending edit once,
 * with those decorators.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { FieldStudio } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/field-studio";

const update = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({ updateFieldAction: update }));

const base = {
  id: "f1", name: "shipTo", type: "string", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null,
  description: "", classification: null, aliases: [] as string[],
};
const FIELD = { ...base, decorators: { keep: "me" } as Record<string, unknown> };
const ENTITY = { id: "ent-1", name: "Order", slug: "order", domainSlug: "payments", productSlug: "checkout" };
const DOMAIN = { name: "Payments", policy: null };

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  // The studio keeps which panels are open in localStorage.
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    configurable: true,
  });
});
/** The studio logs a save that throws. The tests that make one read that log, and keep the console quiet otherwise. */
function quietConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

let quiet: ReturnType<typeof quietConsoleError>;
beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({ success: true });
  quiet = quietConsoleError();
});
afterEach(() => {
  cleanup();
  quiet.mockRestore();
});

function mount(field: typeof FIELD = FIELD) {
  return render(<FieldStudio field={field} entity={ENTITY} domain={DOMAIN} />);
}
const nameInput = () => screen.getByTestId("field-studio-name");
const rename = (value: string) => fireEvent.change(nameInput(), { target: { value } });
const status = () => screen.queryByTestId("field-studio-save-status")?.getAttribute("data-status") ?? "idle";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const WAIT = { timeout: 3000 };
// The machine running the suite can be slow: a test that waits on the debounce several times gets room.
const TEST_TIMEOUT = 15_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Field Studio autosave queue", () => {
  it("a rejected save shows the error, and the next edit saves again", async () => {
    update.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mount();

    rename("shipTo2");
    await waitFor(() => expect(status()).toBe("error"), WAIT);
    expect(screen.getByRole("alert").textContent).toContain("Could not reach the server");

    rename("shipTo3");
    await waitFor(() => expect(status()).toBe("saved"), WAIT);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][1]).toMatchObject({ name: "shipTo3" });
  }, TEST_TIMEOUT);

  it("Retry sends the change again after a rejected save", async () => {
    update.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mount();

    rename("shipTo2");
    await waitFor(() => expect(status()).toBe("error"), WAIT);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(status()).toBe("saved"), WAIT);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][1]).toMatchObject({ name: "shipTo2" });
  }, TEST_TIMEOUT);

  it("Done stays on the page while the save is refused, and leaves once it is saved", async () => {
    update.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mount();

    rename("shipTo2");
    fireEvent.click(screen.getByTestId("field-studio-done"));
    await waitFor(() => expect(status()).toBe("error"), WAIT);
    expect(push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("field-studio-done"));
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1), WAIT);
    expect(push.mock.calls[0][0]).toContain("order");
  }, TEST_TIMEOUT);

  it("an edit made while a save is in flight is sent after it, and Saved shows only once that save is persisted", async () => {
    const first = deferred<{ success: true }>();
    const second = deferred<{ success: true }>();
    update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mount();

    rename("shipTo2");
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1), WAIT);
    rename("shipTo3");
    // The debounce of the second edit passes while the first save is still in flight: it must wait for it, not be dropped.
    await pause(600);
    expect(update).toHaveBeenCalledTimes(1);

    first.resolve({ success: true });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2), WAIT);
    expect(update.mock.calls[1][1]).toMatchObject({ name: "shipTo3" });
    expect(status()).toBe("saving");

    second.resolve({ success: true });
    await waitFor(() => expect(status()).toBe("saved"), WAIT);
  }, TEST_TIMEOUT);

  it("unmounting sends a pending edit at once, and a save the server refuses is reported", async () => {
    update.mockResolvedValueOnce({ error: "A field with that name already exists" });
    const view = mount();

    rename("dup");
    view.unmount();

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1), WAIT);
    expect(update.mock.calls[0][0]).toBe("f1");
    expect(update.mock.calls[0][1]).toMatchObject({ name: "dup" });
    await waitFor(
      () => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("dup"), { description: "A field with that name already exists" }),
      WAIT,
    );
  }, TEST_TIMEOUT);

  it("a server refresh sends the pending edit with the refreshed decorators, and only once", async () => {
    const view = mount();

    rename("shipTo2");
    view.rerender(
      <FieldStudio field={{ ...FIELD, decorators: { keep: "me", server: "refreshed" } }} entity={ENTITY} domain={DOMAIN} />,
    );

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1), { timeout: 300 });
    expect(update.mock.calls[0][1]).toMatchObject({ name: "shipTo2", decorators: { keep: "me", server: "refreshed" } });
    await pause(600);
    expect(update).toHaveBeenCalledTimes(1);
  }, TEST_TIMEOUT);

  it("a server refresh with nothing pending sends nothing", async () => {
    const view = mount();

    view.rerender(<FieldStudio field={{ ...FIELD, decorators: { keep: "me", server: "refreshed" } }} entity={ENTITY} domain={DOMAIN} />);

    await pause(600);
    expect(update).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("a refusal the server answers (not a throw) shows the message, and the next edit saves again", async () => {
    update.mockResolvedValueOnce({ error: "A field with that name already exists" });
    mount();

    rename("shipTo2");
    await waitFor(() => expect(status()).toBe("error"), WAIT);
    expect(screen.getByRole("alert").textContent).toContain("A field with that name already exists");

    rename("shipTo3");
    await waitFor(() => expect(status()).toBe("saved"), WAIT);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][1]).toMatchObject({ name: "shipTo3" });
  }, TEST_TIMEOUT);

  it("a refresh and an edit queued during a save, then a refusal of the queued send: the refusal is shown once, and nothing is sent after it", async () => {
    const first = deferred<{ success: true }>();
    const second = deferred<{ error: string }>();
    update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = mount();

    rename("shipTo2");
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1), WAIT);
    rename("shipTo3");
    view.rerender(<FieldStudio field={{ ...FIELD, decorators: { keep: "me", server: "refreshed" } }} entity={ENTITY} domain={DOMAIN} />);

    first.resolve({ success: true });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2), WAIT);
    expect(update.mock.calls[1][1]).toMatchObject({ name: "shipTo3", decorators: { keep: "me", server: "refreshed" } });

    second.resolve({ error: "A field with that name already exists" });
    await waitFor(() => expect(status()).toBe("error"), WAIT);
    expect(screen.getByRole("alert").textContent).toContain("A field with that name already exists");
    // The debounce of the queued edit must not send it a third time after the refusal.
    await pause(600);
    expect(update).toHaveBeenCalledTimes(2);
  }, TEST_TIMEOUT);

  it("an edit made while a refused save is in flight is sent straight after the refusal, and the refusal is not shown for it", async () => {
    const first = deferred<{ error: string }>();
    const second = deferred<{ success: true }>();
    update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mount();

    rename("shipTo2");
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1), WAIT);
    rename("shipTo3");
    first.resolve({ error: "A field with that name already exists" });

    // Not on the debounce of the newer edit, and not on another user action: the queue goes on with it.
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2), { timeout: 300 });
    expect(update.mock.calls[1][1]).toMatchObject({ name: "shipTo3" });
    expect(status()).toBe("saving");
    expect(screen.queryByRole("alert")).toBeNull();

    second.resolve({ success: true });
    await waitFor(() => expect(status()).toBe("saved"), WAIT);
  }, TEST_TIMEOUT);

  it("a refused save that a newer edit does not fix shows the newer refusal, and waits for the user", async () => {
    const first = deferred<{ error: string }>();
    const second = deferred<{ error: string }>();
    update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mount();

    rename("shipTo2");
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1), WAIT);
    rename("shipTo3");
    first.resolve({ error: "A field with that name already exists" });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2), { timeout: 300 });
    second.resolve({ error: "Field number 4 is already assigned" });

    await waitFor(() => expect(status()).toBe("error"), WAIT);
    expect(screen.getByRole("alert").textContent).toContain("Field number 4 is already assigned");
    expect(update).toHaveBeenCalledTimes(2);

    // Retry sends the newest state again, and nothing else is sent meanwhile.
    update.mockResolvedValueOnce({ success: true });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(status()).toBe("saved"), WAIT);
    expect(update).toHaveBeenCalledTimes(3);
    expect(update.mock.calls[2][1]).toMatchObject({ name: "shipTo3" });
  }, TEST_TIMEOUT);

  it("a server refresh while a save is in flight waits for it: one request at a time, and the queued edit carries the refreshed decorators", async () => {
    const first = deferred<{ success: true }>();
    update.mockReturnValueOnce(first.promise);
    const view = mount();

    rename("shipTo2");
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1), WAIT);
    rename("shipTo3");
    view.rerender(<FieldStudio field={{ ...FIELD, decorators: { keep: "me", server: "refreshed" } }} entity={ENTITY} domain={DOMAIN} />);
    await pause(600);
    expect(update).toHaveBeenCalledTimes(1);

    first.resolve({ success: true });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2), WAIT);
    expect(update.mock.calls[1][1]).toMatchObject({ name: "shipTo3", decorators: { keep: "me", server: "refreshed" } });
    await waitFor(() => expect(status()).toBe("saved"), WAIT);
    expect(update).toHaveBeenCalledTimes(2);
  }, TEST_TIMEOUT);

  it("logs the cause of a save that throws, and shows that the server could not be reached", async () => {
    const cause = new TypeError("Failed to fetch");
    update.mockRejectedValueOnce(cause);
    mount();

    rename("shipTo2");
    await waitFor(() => expect(status()).toBe("error"), WAIT);
    expect(quiet).toHaveBeenCalledWith(expect.stringContaining("field-studio"), cause);
    expect(screen.getByRole("alert").textContent).toContain("Could not reach the server");
  }, TEST_TIMEOUT);

  it("Cmd+S with nothing unsaved confirms Saved, and sends nothing", async () => {
    mount();

    fireEvent.keyDown(document, { key: "s", metaKey: true });

    await waitFor(() => expect(status()).toBe("saved"), WAIT);
    expect(update).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("Cmd+S sends a pending edit at once, without waiting for the debounce", async () => {
    mount();

    rename("shipTo2");
    fireEvent.keyDown(document, { key: "s", metaKey: true });

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1), { timeout: 300 });
    expect(update.mock.calls[0][1]).toMatchObject({ name: "shipTo2" });
    await waitFor(() => expect(status()).toBe("saved"), WAIT);
    await pause(600);
    expect(update).toHaveBeenCalledTimes(1);
  }, TEST_TIMEOUT);

  it("the browser asks before the tab closes while an edit is unsaved, and not once every edit is saved", async () => {
    mount();
    const leaving = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leaving()).toBe(false);

    rename("shipTo2");
    expect(leaving()).toBe(true);

    await waitFor(() => expect(status()).toBe("saved"), WAIT);
    expect(leaving()).toBe(false);
  }, TEST_TIMEOUT);
});
