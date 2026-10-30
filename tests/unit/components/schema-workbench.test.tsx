// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, configure } from "@testing-library/react";
import { SchemaWorkbench } from "@/components/custom/SchemaWorkbench";

// The first live check loads the importers on demand; under a loaded machine that can outlast the 1s default.
configure({ asyncUtilTimeout: 5000 });

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

// Paste mode is the default and has no Detail Panel; an editable imported schema comes from a file (Drop file mode).
function chooseFile(text: string, name = "x.json") {
  fireEvent.click(screen.getByTestId("workbench-mode-drop"));
  fireEvent.change(screen.getByTestId("workbench-file-input"), { target: { files: [new File([text], name)] } });
}

async function fileLoad(text: string, name = "x.json") {
  chooseFile(text, name);
  await waitFor(() => expect(panel().value).toBe(text));
}

const pasteBox = () => screen.getByTestId("workbench-paste-textarea");
const pasteStatus = () => screen.getByTestId("workbench-paste-status");
const reviewButton = () => screen.getByTestId("workbench-review-button") as HTMLButtonElement;

describe("SchemaWorkbench — paste mode", () => {
  it("opens on Paste, tabs in order, with no Load button and no Detail Panel", () => {
    // The From URL tab only exists when the host can take an import result.
    setup({ onImportResult: vi.fn() });
    const tabs = ["paste", "drop", "url", "form"].map((id) => screen.getByTestId(`workbench-mode-${id}`));
    expect(tabs.map((t) => t.textContent)).toEqual(["Paste", "Drop file", "From URL", "Build form"]);
    expect(tabs[0].compareDocumentPosition(tabs[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tabs[2].compareDocumentPosition(tabs[3]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tabs[0].getAttribute("aria-pressed")).toBe("true");
    expect(tabs[1].getAttribute("aria-pressed")).toBe("false");
    expect(pasteBox()).toBeDefined();
    expect(screen.queryByTestId("workbench-load-button")).toBeNull();
    expect(screen.queryByTestId("detail-panel-textarea")).toBeNull();
    expect(screen.queryByTestId("workbench-dropzone")).toBeNull();
  });

  it("shows a hint without a state while empty, and Review & Import is disabled", () => {
    setup();
    expect(pasteStatus().getAttribute("data-state")).toBeNull();
    expect(reviewButton().disabled).toBe(true);
  });

  it("checks the text after the debounce: Checking, then Loads with a summary", async () => {
    setup();
    fireEvent.change(pasteBox(), { target: { value: AVRO } });
    expect(pasteStatus().getAttribute("data-state")).toBe("checking");
    expect(pasteStatus().textContent).toContain("Checking");
    expect(reviewButton().disabled).toBe(true);

    await waitFor(() => expect(pasteStatus().getAttribute("data-state")).toBe("valid"));
    expect(pasteStatus().textContent).toBe("Loads: Avro, entity Customer with 1 field");
    expect(reviewButton().disabled).toBe(false);
  });

  it("explains why text cannot load and keeps Review & Import disabled", async () => {
    setup();
    fireEvent.change(pasteBox(), { target: { value: "{ not json" } });
    await waitFor(() => expect(pasteStatus().getAttribute("data-state")).toBe("invalid"));
    expect(pasteStatus().textContent).toMatch(/^Cannot load this schema: .+/);
    expect(reviewButton().disabled).toBe(true);
  });

  it("flips from valid to invalid when the text is edited", async () => {
    setup();
    fireEvent.change(pasteBox(), { target: { value: AVRO } });
    await waitFor(() => expect(pasteStatus().getAttribute("data-state")).toBe("valid"));

    fireEvent.change(pasteBox(), { target: { value: AVRO.slice(0, -4) } });
    expect(pasteStatus().getAttribute("data-state")).toBe("checking");
    expect(reviewButton().disabled).toBe(true);
    await waitFor(() => expect(pasteStatus().getAttribute("data-state")).toBe("invalid"));
    expect(reviewButton().disabled).toBe(true);
  });

  it("only the latest edit's answer applies", async () => {
    setup();
    fireEvent.change(pasteBox(), { target: { value: "{ not json" } });
    fireEvent.change(pasteBox(), { target: { value: AVRO } });
    await waitFor(() => expect(pasteStatus().getAttribute("data-state")).toBe("valid"));
    expect(pasteStatus().textContent).toMatch(/^Loads: Avro/);
  });

  it("clearing the box returns to the empty hint", async () => {
    setup();
    fireEvent.change(pasteBox(), { target: { value: AVRO } });
    await waitFor(() => expect(pasteStatus().getAttribute("data-state")).toBe("valid"));
    fireEvent.change(pasteBox(), { target: { value: "" } });
    expect(pasteStatus().getAttribute("data-state")).toBeNull();
    expect(reviewButton().disabled).toBe(true);
  });

  it("Review & Import commits the pasted text with no filename or format", async () => {
    const { onCommit } = setup();
    fireEvent.change(pasteBox(), { target: { value: AVRO } });
    await waitFor(() => expect(reviewButton().disabled).toBe(false));
    fireEvent.click(reviewButton());
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(AVRO, undefined);
  });

  it("does not commit while the wizard is loading, even for loadable text", async () => {
    const { onCommit } = setup({ isLoading: true });
    fireEvent.change(pasteBox(), { target: { value: AVRO } });
    await waitFor(() => expect(pasteStatus().getAttribute("data-state")).toBe("valid"));
    expect(reviewButton().disabled).toBe(true);
    fireEvent.click(reviewButton());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("only recognises TypeSpec, deferring the compile to Review", async () => {
    const { onCommit } = setup();
    const tsp = 'import "@typespec/http";\n\nmodel Customer {\n  id: int64;\n  name: string;\n}\n';
    fireEvent.change(pasteBox(), { target: { value: tsp } });
    await waitFor(() => expect(pasteStatus().getAttribute("data-state")).toBe("valid"));
    expect(pasteStatus().textContent).toBe("Loads: TypeSpec document, compiled when you review");
    fireEvent.click(reviewButton());
    expect(onCommit).toHaveBeenCalledWith(tsp, undefined);
  });

  it("pasting does not load an import: no summary, no Detail Panel", async () => {
    setup();
    fireEvent.change(pasteBox(), { target: { value: AVRO } });
    await waitFor(() => expect(pasteStatus().getAttribute("data-state")).toBe("valid"));
    expect(screen.queryByTestId("workbench-import-summary")).toBeNull();
    expect(screen.queryByTestId("detail-panel-textarea")).toBeNull();
    // Nothing was imported, so a later switch to Build form has nothing to discard.
    fireEvent.click(screen.getByTestId("workbench-mode-form"));
    expect(screen.queryByTestId("workbench-discard-confirm")).toBeNull();
    expect(screen.getByTestId("jsonschema-visual-editor")).toBeDefined();
  });
});

describe("SchemaWorkbench — imported origin", () => {
  it("loads a dropped file into the Detail Panel", async () => {
    setup();
    fireEvent.click(screen.getByTestId("workbench-mode-drop"));
    const file = new File([AVRO], "customer.avsc", { type: "application/json" });
    fireEvent.drop(screen.getByTestId("workbench-dropzone"), { dataTransfer: { files: [file] } });
    await waitFor(() => expect(panel().value).toBe(AVRO));
    expect(screen.getByTestId("workbench-import-summary").textContent).toContain("customer.avsc");
  });

  it("loads a chosen file and highlights edited lines in red", async () => {
    setup();
    await fileLoad(AVRO);
    const editor = () => screen.getByTestId("detail-panel-textarea-editor");
    expect(editor().getAttribute("data-changed-count")).toBe("0");

    fireEvent.change(panel(), { target: { value: AVRO.replace("Customer", "Client") } });
    // JSON renders through JsonEditor (CodeMirror; its textarea fallback in jsdom), which marks the changed lines.
    expect(editor().getAttribute("data-language")).toBe("json");
    expect(editor().getAttribute("data-changed-count")).toBe("1");
    expect(screen.getByTestId("detail-panel-changes").textContent).toMatch(/1 changed/);
  });

  it("resets to the original text", async () => {
    setup();
    await fileLoad(AVRO);
    fireEvent.change(panel(), { target: { value: "edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset to original" }));
    expect(panel().value).toBe(AVRO);
  });

  it("commits the edited text and lets the wizard re-detect the format", async () => {
    const { onCommit } = setup();
    await fileLoad(AVRO);
    const edited = AVRO.replace("Customer", "Client");
    fireEvent.change(panel(), { target: { value: edited } });
    fireEvent.click(screen.getByTestId("workbench-review-button"));
    expect(onCommit).toHaveBeenCalledWith(edited, undefined, "x.json");
  });

  it("does not sync an imported schema into the form", async () => {
    setup();
    await fileLoad(AVRO);
    fireEvent.change(panel(), { target: { value: AVRO.replace("Customer", "Client") } });
    expect(screen.queryByTestId("avro-visual-editor")).toBeNull();
    expect(screen.queryByTestId("workbench-unmappable")).toBeNull();
  });

  it("asks before discarding an import for the form, and keeps it on cancel", async () => {
    setup();
    await fileLoad(AVRO);
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

describe("SchemaWorkbench — sync guard regressions", () => {
  function startFormWithEmail() {
    fireEvent.click(screen.getByRole("button", { name: "Build form" }));
    fireEvent.change(screen.getByPlaceholderText("propertyName"), { target: { value: "email" } });
  }
  const renamed = (to: string, indent = 4) => {
    const doc = JSON.parse(panel().value);
    const [from] = Object.keys(doc.properties);
    doc.properties = { [to]: doc.properties[from] };
    if (doc.required) doc.required = doc.required.map((r: string) => (r === from ? to : r));
    return JSON.stringify(doc, null, indent);
  };
  const settle = () =>
    act(() => {
      vi.advanceTimersByTime(400);
    });
  const fieldName = () => (screen.getByPlaceholderText("propertyName") as HTMLInputElement).value;

  it("keeps panel text that parses to zero usable fields instead of wiping it", () => {
    vi.useFakeTimers();
    setup();
    startFormWithEmail();
    const empty = '{"title":"T","type":"object","properties":{}}';
    fireEvent.change(panel(), { target: { value: empty } });
    settle();
    expect(panel().value).toBe(empty);
  });

  it("a form edit after a panel-driven hydrate is never swallowed (rename and back)", () => {
    vi.useFakeTimers();
    setup();
    startFormWithEmail();
    fireEvent.change(panel(), { target: { value: renamed("mail") } });
    settle();
    expect(fieldName()).toBe("mail");

    fireEvent.change(screen.getByPlaceholderText("propertyName"), { target: { value: "x" } });
    expect(JSON.parse(panel().value).properties.x).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText("propertyName"), { target: { value: "mail" } });

    // Panel must follow the form again, not stay on the stale "x".
    expect(JSON.parse(panel().value).properties).toHaveProperty("mail");
    expect(JSON.parse(panel().value).properties).not.toHaveProperty("x");
    expect(fieldName()).toBe("mail");
  });

  it("a form edit inside the debounce window beats the stale panel parse", () => {
    vi.useFakeTimers();
    setup();
    startFormWithEmail();
    fireEvent.change(panel(), { target: { value: renamed("mail") } });
    // no time passes: the panel parse is still pending
    fireEvent.change(screen.getByPlaceholderText("propertyName"), { target: { value: "other" } });
    settle();

    expect(fieldName()).toBe("other");
    expect(JSON.parse(panel().value).properties).toHaveProperty("other");
  });

  it("does not parse after unmount", () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(<SchemaWorkbench onCommit={vi.fn()} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Build form" }));
    fireEvent.change(screen.getByPlaceholderText("propertyName"), { target: { value: "email" } });
    fireEvent.change(panel(), { target: { value: renamed("mail") } });
    unmount();
    expect(() => settle()).not.toThrow();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("refuses to map text the form would rewrite, keeping form and text", () => {
    vi.useFakeTimers();
    setup();
    startFormWithEmail();
    const lossy = JSON.stringify({
      title: "T",
      type: "object",
      properties: { a: { type: "string", default: "" } },
    });
    fireEvent.change(panel(), { target: { value: lossy } });
    settle();
    expect(screen.getByTestId("workbench-unmappable")).toBeDefined();
    expect(panel().value).toBe(lossy);
    expect(fieldName()).toBe("email");
  });
});

describe("SchemaWorkbench — import affordances", () => {
  it("accepts the supported schema file types", () => {
    setup();
    fireEvent.click(screen.getByTestId("workbench-mode-drop"));
    const input = screen.getByTestId("workbench-file-input") as HTMLInputElement;
    expect(input.accept.split(",").sort()).toEqual(
      [".avro", ".avsc", ".ddl", ".json", ".proto", ".sql", ".tsp", ".yaml", ".yml"].sort()
    );
  });

  it("loads a file chosen with the browse input", async () => {
    setup();
    fireEvent.click(screen.getByTestId("workbench-mode-drop"));
    const file = new File([AVRO], "picked.avsc");
    fireEvent.change(screen.getByTestId("workbench-file-input"), { target: { files: [file] } });
    await waitFor(() => expect(panel().value).toBe(AVRO));
    expect(screen.getByTestId("workbench-import-summary").textContent).toContain("picked.avsc");
  });

  it("passes the dropped file's name to onCommit", async () => {
    const { onCommit } = setup();
    fireEvent.click(screen.getByTestId("workbench-mode-drop"));
    const file = new File([AVRO], "customer.avsc");
    fireEvent.drop(screen.getByTestId("workbench-dropzone"), { dataTransfer: { files: [file] } });
    await waitFor(() => expect(panel().value).toBe(AVRO));
    fireEvent.click(screen.getByTestId("workbench-review-button"));
    expect(onCommit).toHaveBeenCalledWith(AVRO, undefined, "customer.avsc");
  });

  it("Start over clears the import and the panel", async () => {
    setup();
    await fileLoad(AVRO);
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(panel().value).toBe("");
    expect(screen.queryByTestId("workbench-import-summary")).toBeNull();
    expect((screen.getByTestId("workbench-review-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("marks where a baseline line was removed", async () => {
    setup();
    await fileLoad(AVRO);
    const lines = AVRO.split("\n");
    fireEvent.change(panel(), { target: { value: [...lines.slice(0, 2), ...lines.slice(3)].join("\n") } });
    expect(screen.getByTestId("detail-panel-textarea-editor").getAttribute("data-removed-count")).toBe("1");
    expect(screen.getByTestId("detail-panel-changes").textContent).toMatch(/removed/);
  });
});

describe("SchemaWorkbench — confirms before discarding work", () => {
  const confirmBox = () => screen.queryByTestId("workbench-discard-confirm");

  function buildEmailForm() {
    fireEvent.click(screen.getByRole("button", { name: "Build form" }));
    fireEvent.change(screen.getByPlaceholderText("propertyName"), { target: { value: "email" } });
  }

  it("asks before loading a file over a built form; Cancel keeps the form", () => {
    setup();
    buildEmailForm();
    const built = panel().value;
    chooseFile(AVRO);

    expect(confirmBox()?.textContent).toMatch(/discards the form you built/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirmBox()).toBeNull();
    expect(panel().value).toBe(built);
  });

  it("loads the file once the discard is confirmed", async () => {
    setup();
    buildEmailForm();
    chooseFile(AVRO);
    fireEvent.click(screen.getByRole("button", { name: "Discard & load" }));
    await waitFor(() => expect(panel().value).toBe(AVRO));
    expect(screen.queryByTestId("jsonschema-visual-editor")).toBeNull();
  });

  it("asks before a dropped file replaces a built form, and does not load until confirmed", async () => {
    setup();
    buildEmailForm();
    const built = panel().value;
    fireEvent.click(screen.getByRole("button", { name: "Drop file" }));
    const file = new File([AVRO], "customer.avsc");
    fireEvent.drop(screen.getByTestId("workbench-dropzone"), { dataTransfer: { files: [file] } });

    expect(confirmBox()).not.toBeNull();
    expect(panel().value).toBe(built);

    fireEvent.click(screen.getByRole("button", { name: "Discard & load" }));
    await waitFor(() => expect(panel().value).toBe(AVRO));
  });

  it("asks before replacing an imported schema the user has edited", async () => {
    setup();
    await fileLoad(AVRO);
    fireEvent.change(panel(), { target: { value: AVRO.replace("Customer", "Client") } });
    chooseFile(AVRO);
    expect(confirmBox()?.textContent).toMatch(/discards your edits/);
  });

  it("does not ask when replacing an untouched import, or when nothing is loaded", async () => {
    setup();
    chooseFile(AVRO);
    expect(confirmBox()).toBeNull();
    await waitFor(() => expect(panel().value).toBe(AVRO));

    chooseFile(AVRO.replace("Customer", "Other"));
    expect(confirmBox()).toBeNull();
    await waitFor(() => expect(panel().value).toContain("Other"));
  });

  it("asks before switching the Build-form format when the form has content", () => {
    setup();
    buildEmailForm();
    fireEvent.click(screen.getByRole("button", { name: "Avro" }));
    expect(confirmBox()?.textContent).toMatch(/Switching format/);
    expect(screen.getByTestId("jsonschema-visual-editor")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("jsonschema-visual-editor")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Avro" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard form" }));
    expect(screen.getByTestId("avro-visual-editor")).toBeDefined();
    expect(panel().value).toBe("");
  });

  it("switches format without asking when the form is empty", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Build form" }));
    fireEvent.click(screen.getByRole("button", { name: "Protobuf" }));
    expect(confirmBox()).toBeNull();
    expect(screen.getByTestId("protobuf-visual-editor")).toBeDefined();
  });

  it("does not ask when re-selecting the current format", () => {
    setup();
    buildEmailForm();
    fireEvent.click(screen.getByRole("button", { name: "JSON Schema" }));
    expect(confirmBox()).toBeNull();
    expect(fieldNameValue()).toBe("email");
  });

  function fieldNameValue() {
    return (screen.getByPlaceholderText("propertyName") as HTMLInputElement).value;
  }
});
