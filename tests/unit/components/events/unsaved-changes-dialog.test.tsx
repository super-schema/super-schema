// @vitest-environment jsdom
// tests/unit/components/events/unsaved-changes-dialog.test.tsx
// The question the leave guard asks: Save & leave / Discard & leave / Stay. The dialog stays open until the guard's `pending` is cleared,
// which only `proceed()` (after a save that worked, or a discard) and `stay()` do.
import { useState, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { UnsavedChangesDialog } from "@/features/events/builder/UnsavedChangesDialog";
import type { PendingLeave } from "@/features/events/builder/use-leave-guard";

afterEach(() => cleanup());

interface MockPending extends PendingLeave { proceed: Mock<() => void>; stay: Mock<() => void> }
function makePending(): MockPending {
  return { destination: "/schemas/payments", proceed: vi.fn<() => void>(), stay: vi.fn<() => void>() };
}

function setup(over: Partial<ComponentProps<typeof UnsavedChangesDialog>> = {}) {
  const pending = makePending();
  const props = {
    pending: pending as PendingLeave, saving: false, error: null as string | null,
    onSaveAndLeave: vi.fn().mockResolvedValue(true), onDiscardAndLeave: vi.fn(), onStay: vi.fn(),
    ...over,
  };
  const view = render(<UnsavedChangesDialog {...props} />);
  return { pending, props, ...view };
}

const stayButton = () => screen.getByTestId("leave-stay") as HTMLButtonElement;
const discardButton = () => screen.getByTestId("leave-discard") as HTMLButtonElement;
const saveButton = () => screen.getByTestId("leave-save") as HTMLButtonElement;

describe("UnsavedChangesDialog: content", () => {
  it("renders nothing while there is no pending leave", () => {
    setup({ pending: null });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a labelled dialog with exactly the three ways out", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    expect(screen.getByRole("heading", { name: "Unsaved changes" })).toBeDefined();
    expect(dialog.textContent).toContain("unsaved changes");
    // (the dialog's focus guards are role=button spans; the real buttons are the <button>s)
    expect(Array.from(dialog.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Stay", "Discard & leave", "Save & leave"]); // no extra X: Stay is the way back
  });

  it("shows no error until a save failed", () => {
    setup();
    expect(screen.queryByTestId("unsaved-changes-error")).toBeNull();
  });

  it("shows the failed save's error, as an alert", () => {
    setup({ error: "2 problem(s) in the event document" });
    const error = screen.getByTestId("unsaved-changes-error");
    expect(error.textContent).toBe("2 problem(s) in the event document");
    expect(error.getAttribute("role")).toBe("alert");
  });
});

describe("UnsavedChangesDialog: Stay", () => {
  it("Stay asks the page to stay and leaves nothing else done", () => {
    const { props, pending } = setup();
    fireEvent.click(stayButton());
    expect(props.onStay).toHaveBeenCalledTimes(1);
    expect(props.onSaveAndLeave).not.toHaveBeenCalled();
    expect(props.onDiscardAndLeave).not.toHaveBeenCalled();
    expect(pending.proceed).not.toHaveBeenCalled();
  });

  it("Escape stays too", () => {
    const { props, pending } = setup();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onStay).toHaveBeenCalledTimes(1);
    expect(pending.proceed).not.toHaveBeenCalled();
  });

  it("puts the first focus on the harmless choice", async () => {
    setup();
    await waitFor(() => expect(document.activeElement).toBe(stayButton()));
  });
});

describe("UnsavedChangesDialog: Save & leave", () => {
  it("saves first and leaves only after the save worked", async () => {
    let resolve!: (saved: boolean) => void;
    const onSaveAndLeave = vi.fn(() => new Promise<boolean>((r) => { resolve = r; }));
    const { pending } = setup({ onSaveAndLeave });
    fireEvent.click(saveButton());
    expect(onSaveAndLeave).toHaveBeenCalledTimes(1);
    expect(pending.proceed).not.toHaveBeenCalled();
    resolve(true);
    await waitFor(() => expect(pending.proceed).toHaveBeenCalledTimes(1));
  });

  it("a failed save keeps the dialog open, the user on the page and the error visible", async () => {
    const onSaveAndLeave = vi.fn().mockResolvedValue(false);
    const { pending, props, rerender } = setup({ onSaveAndLeave });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaveAndLeave).toHaveBeenCalled());
    // the page now reports the failure through `error`
    rerender(<UnsavedChangesDialog {...props} pending={pending} error="The document has 1 problem" />);
    expect(pending.proceed).not.toHaveBeenCalled();
    expect(props.onStay).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByTestId("unsaved-changes-error").textContent).toBe("The document has 1 problem");
    expect(saveButton().disabled).toBe(false); // and it can be tried again
  });

  it("while saving: every choice is disabled, Save says so, and Escape does not close the question", () => {
    const { props } = setup({ saving: true });
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().textContent).toBe("Saving…");
    expect(stayButton().disabled).toBe(true);
    expect(discardButton().disabled).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onStay).not.toHaveBeenCalled();
  });
});

describe("UnsavedChangesDialog: Discard & leave", () => {
  it("discards the changes, then leaves", () => {
    const order: string[] = [];
    const onDiscardAndLeave = vi.fn(() => { order.push("discard"); });
    const pending = makePending();
    pending.proceed.mockImplementation(() => { order.push("proceed"); });
    setup({ pending, onDiscardAndLeave });
    fireEvent.click(discardButton());
    expect(order).toEqual(["discard", "proceed"]);
  });

  it("does not save", () => {
    const { props } = setup();
    fireEvent.click(discardButton());
    expect(props.onSaveAndLeave).not.toHaveBeenCalled();
  });
});

describe("UnsavedChangesDialog: focus", () => {
  function Host() {
    const [pending, setPending] = useState<PendingLeave | null>(null);
    return (
      <>
        <input data-testid="field" />
        <button type="button" data-testid="open" onClick={() => setPending({ destination: "/x", proceed: () => setPending(null), stay: () => setPending(null) })}>open</button>
        <UnsavedChangesDialog
          pending={pending} saving={false} error={null}
          onSaveAndLeave={() => Promise.resolve(true)} onDiscardAndLeave={() => undefined} onStay={() => pending?.stay()}
        />
      </>
    );
  }

  it("returns focus to the element that had it before the question", async () => {
    render(<Host />);
    const field = screen.getByTestId("field");
    field.focus();
    fireEvent.click(screen.getByTestId("open")); // a click that does not move focus in jsdom: the field keeps it
    expect(screen.getByRole("dialog")).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(stayButton()));
    fireEvent.click(stayButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(field);
  });
});
