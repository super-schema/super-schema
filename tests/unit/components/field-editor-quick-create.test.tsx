/**
 * "Quick Create" in the field editor keeps the dialog open, with the typed name, when the server refuses the field (a name the AsyncAPI parser
 * cannot read, a duplicate ...): the refusal is shown as a toast by the workspace, and the person fixes the name instead of typing it again.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FieldEditor } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/field-editor";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

afterEach(cleanup);

function renderEditor(onAddField: (name: string, type: string) => Promise<unknown>) {
  return render(
    <FieldEditor
      entityId="ent-1"
      entitySlug="customer"
      domainSlug="payments"
      productSlug="checkout"
      fields={[]}
      domainPolicy={null}
      onAddField={onAddField as never}
      onUpdateField={async () => {}}
      onDeleteField={async () => {}}
      onReorderFields={async () => true}
    />,
  );
}

async function quickCreate(name: string) {
  fireEvent.click(screen.getByText("Add Field"));
  const input = screen.getByPlaceholderText("field_name") as HTMLInputElement;
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(screen.getByText("Quick Create"));
  return input;
}

describe("FieldEditor quick create", () => {
  it("keeps the dialog open and the typed name when the server refuses the field", async () => {
    const onAddField = vi.fn(async () => ({ error: '"hasOwnProperty" is a reserved name: AsyncAPI documents cannot contain it. Choose another field name.', code: "VALIDATION_ERROR" }));
    renderEditor(onAddField);

    await quickCreate("hasOwnProperty");

    await waitFor(() => expect(onAddField).toHaveBeenCalledWith("hasOwnProperty", "string"));
    // the button comes back (not creating any more) and the dialog still shows what was typed
    await waitFor(() => expect((screen.getByText("Quick Create").closest("button") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText("New Field")).toBeDefined();
    expect((screen.getByPlaceholderText("field_name") as HTMLInputElement).value).toBe("hasOwnProperty");
  });

  it("closes the dialog when the field was created", async () => {
    const onAddField = vi.fn(async () => ({ success: true }));
    renderEditor(onAddField);

    await quickCreate("email");

    await waitFor(() => expect(screen.queryByText("New Field")).toBeNull());
    expect(onAddField).toHaveBeenCalledWith("email", "string");
  });
});
