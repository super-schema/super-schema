import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";

/** The in-app confirm dialog (`useConfirm`): waits for it, and returns its title and description text. */
export async function findConfirm(): Promise<{ title: string; description: string }> {
  const dialog = await screen.findByTestId("confirm-dialog");
  return {
    title: dialog.querySelector('[data-slot="alert-dialog-title"]')?.textContent ?? "",
    description: dialog.querySelector('[data-slot="alert-dialog-description"]')?.textContent ?? "",
  };
}

/** Clicks Confirm or Cancel in the open dialog, waits for it to close, and lets the handler that was awaiting it finish. */
export async function answerConfirm(confirmed: boolean): Promise<void> {
  fireEvent.click(await screen.findByTestId(confirmed ? "confirm-dialog-confirm" : "confirm-dialog-cancel"));
  await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).toBeNull());
  await act(async () => {}); // the awaiting handler continues in a microtask, outside the click's act scope
}

/** Asserts no confirm dialog is open (call after the action the test expects to go ahead without asking). */
export function expectNoConfirm(): void {
  expect(screen.queryByTestId("confirm-dialog")).toBeNull();
}
