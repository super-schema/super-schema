// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SchemaWorkbench } from "@/components/custom/SchemaWorkbench";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const AVRO = JSON.stringify(
  { type: "record", name: "Customer", fields: [{ name: "id", type: "long" }] },
  null,
  2
);

function setup(props: Partial<React.ComponentProps<typeof SchemaWorkbench>> = {}) {
  const onCommit = vi.fn();
  render(<SchemaWorkbench onCommit={onCommit} onBack={vi.fn()} {...props} />);
  return { onCommit };
}

function panel() {
  return screen.getByTestId("detail-panel-textarea") as HTMLTextAreaElement;
}

async function pasteLoad(text: string) {
  fireEvent.click(screen.getByRole("button", { name: "Paste" }));
  fireEvent.change(screen.getByTestId("workbench-paste-textarea"), { target: { value: text } });
  fireEvent.click(screen.getByTestId("workbench-load-button"));
  await waitFor(() => expect(panel().value).toBe(text));
}

describe("SchemaWorkbench — imported origin", () => {
  it("loads a dropped file into the Detail Panel", async () => {
    setup();
    const file = new File([AVRO], "customer.avsc", { type: "application/json" });
    fireEvent.drop(screen.getByTestId("workbench-dropzone"), { dataTransfer: { files: [file] } });
    await waitFor(() => expect(panel().value).toBe(AVRO));
    expect(screen.getByTestId("workbench-import-summary").textContent).toContain("customer.avsc");
  });

  it("loads pasted text and highlights edited lines in red", async () => {
    setup();
    await pasteLoad(AVRO);
    expect(screen.queryAllByTestId("detail-panel-backdrop")[0]?.querySelector('[data-changed="true"]')).toBeNull();

    fireEvent.change(panel(), { target: { value: AVRO.replace("Customer", "Client") } });
    const changed = screen
      .getByTestId("detail-panel-backdrop")
      .querySelectorAll('[data-changed="true"]');
    expect(changed).toHaveLength(1);
    expect(changed[0].textContent).toContain("Client");
    expect(screen.getByTestId("detail-panel-changes").textContent).toMatch(/1 changed/);
  });

  it("resets to the original text", async () => {
    setup();
    await pasteLoad(AVRO);
    fireEvent.change(panel(), { target: { value: "edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset to original" }));
    expect(panel().value).toBe(AVRO);
  });

  it("commits the edited text and lets the wizard re-detect the format", async () => {
    const { onCommit } = setup();
    await pasteLoad(AVRO);
    const edited = AVRO.replace("Customer", "Client");
    fireEvent.change(panel(), { target: { value: edited } });
    fireEvent.click(screen.getByTestId("workbench-review-button"));
    expect(onCommit).toHaveBeenCalledWith(edited, undefined, undefined);
  });

  it("does not sync an imported schema into the form", async () => {
    setup();
    await pasteLoad(AVRO);
    fireEvent.change(panel(), { target: { value: AVRO.replace("Customer", "Client") } });
    expect(screen.queryByTestId("avro-visual-editor")).toBeNull();
    expect(screen.queryByTestId("workbench-unmappable")).toBeNull();
  });

  it("asks before discarding an import for the form, and keeps it on cancel", async () => {
    setup();
    await pasteLoad(AVRO);
    fireEvent.click(screen.getByRole("button", { name: "Build form" }));
    expect(screen.getByTestId("workbench-discard-confirm")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("workbench-discard-confirm")).toBeNull();
    expect(panel().value).toBe(AVRO);

    fireEvent.click(screen.getByRole("button", { name: "Build form" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard import" }));
    expect(screen.getByTestId("jsonschema-visual-editor")).toBeDefined();
    expect(panel().value).not.toBe(AVRO);
  });
});

describe("SchemaWorkbench — form origin", () => {
  function startForm() {
    fireEvent.click(screen.getByRole("button", { name: "Build form" }));
  }

  it("disables Review & Import until there is content", () => {
    setup();
    expect((screen.getByTestId("workbench-review-button") as HTMLButtonElement).disabled).toBe(true);
    startForm();
    expect((screen.getByTestId("workbench-review-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("form edits flow into the panel and commit with the builder's format", () => {
    const { onCommit } = setup();
    startForm();
    fireEvent.change(screen.getByPlaceholderText("propertyName"), { target: { value: "email" } });
    expect(JSON.parse(panel().value).properties.email.type).toBe("string");

    fireEvent.click(screen.getByTestId("workbench-review-button"));
    expect(onCommit).toHaveBeenCalledWith(panel().value, "json-schema");
  });

  it("panel edits flow back into the form", () => {
    vi.useFakeTimers();
    setup();
    startForm();
    fireEvent.change(screen.getByPlaceholderText("propertyName"), { target: { value: "email" } });

    const doc = JSON.parse(panel().value);
    doc.properties.email.type = "integer";
    const edited = JSON.stringify(doc, null, 4);
    fireEvent.change(panel(), { target: { value: edited } });
    act(() => {
      vi.advanceTimersByTime(400);
    });

    const typeSelect = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    expect(typeSelect.value).toBe("integer");
    // The user's own formatting is kept — the editor's echo must not overwrite it.
    expect(panel().value).toBe(edited);
  });

  it("keeps the form and shows a notice when the panel text can't be mapped", () => {
    vi.useFakeTimers();
    setup();
    startForm();
    fireEvent.change(screen.getByPlaceholderText("propertyName"), { target: { value: "email" } });
    const before = (screen.getByPlaceholderText("propertyName") as HTMLInputElement).value;

    fireEvent.change(panel(), { target: { value: "{ not json" } });
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.getByTestId("workbench-unmappable")).toBeDefined();
    expect((screen.getByPlaceholderText("propertyName") as HTMLInputElement).value).toBe(before);
    expect(panel().value).toBe("{ not json");
  });

  it("a later form edit overwrites an unmappable panel and clears the notice", () => {
    vi.useFakeTimers();
    setup();
    startForm();
    fireEvent.change(screen.getByPlaceholderText("propertyName"), { target: { value: "email" } });
    fireEvent.change(panel(), { target: { value: "{ not json" } });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.change(screen.getByPlaceholderText("propertyName"), { target: { value: "mail" } });

    expect(screen.queryByTestId("workbench-unmappable")).toBeNull();
    expect(JSON.parse(panel().value).properties.mail).toBeDefined();
  });

  it("an emptied panel does not crash or flag as unmappable", () => {
    vi.useFakeTimers();
    setup();
    startForm();
    fireEvent.change(screen.getByPlaceholderText("propertyName"), { target: { value: "email" } });
    fireEvent.change(panel(), { target: { value: "" } });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByTestId("workbench-unmappable")).toBeNull();
    expect((screen.getByTestId("workbench-review-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps form state when switching to another input and back", () => {
    setup();
    startForm();
    fireEvent.change(screen.getByPlaceholderText("propertyName"), { target: { value: "email" } });
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    fireEvent.click(screen.getByRole("button", { name: "Build form" }));
    expect((screen.getByPlaceholderText("propertyName") as HTMLInputElement).value).toBe("email");
  });
});
