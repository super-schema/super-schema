/**
 * @vitest-environment jsdom
 */
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CreateConceptDialog } from "@/features/glossary/CreateConceptDialog";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

function renderDialog(onSubmit: ComponentProps<typeof CreateConceptDialog>["onSubmit"]) {
  const onClose = vi.fn();
  render(<CreateConceptDialog open onClose={onClose} onSubmit={onSubmit} />);
  return { onClose };
}

function submitWithName(name: string) {
  fireEvent.change(screen.getByTestId("concept-name"), { target: { value: name } });
  fireEvent.click(screen.getByTestId("concept-submit"));
}

describe("CreateConceptDialog", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("closes after a successful create", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { onClose } = renderDialog(onSubmit);

    submitWithName("Customer Identifier");

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Customer Identifier", domain: "Core" })
    );
  });

  it("shows a returned error and keeps the submit button usable", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ error: 'A concept named "Customer" already exists' });
    const { onClose } = renderDialog(onSubmit);

    submitWithName("Customer");

    expect((await screen.findByTestId("concept-error")).textContent).toBe(
      'A concept named "Customer" already exists'
    );
    expect((screen.getByTestId("concept-submit") as HTMLButtonElement).disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("recovers when the create call rejects: the generic message shows and the button is no longer stuck on 'Creating...'", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("Failed to fetch"));
    const { onClose } = renderDialog(onSubmit);

    submitWithName("Customer");

    expect((await screen.findByTestId("concept-error")).textContent).toBe(GENERIC_ACTION_ERROR);
    const submit = screen.getByTestId("concept-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe("Create Concept");
    expect(onClose).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
});
