// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, configure } from "@testing-library/react";
import { SchemaWorkbench } from "@/components/custom/SchemaWorkbench";
import type { SchemaTextCheck } from "@/lib/schema-workbench/check-schema-text";

// The first live check loads the importers on demand; under a loaded machine that can outlast the 1s default.
configure({ asyncUtilTimeout: 5000 });

// Real check by default; a test can hold individual answers back to see how late ones are handled.
const gate = vi.hoisted(() => ({ hold: null as null | ((text: string) => Promise<unknown>) }));
vi.mock("@/lib/schema-workbench/check-schema-text", async () => {
  const actual = await vi.importActual<typeof import("@/lib/schema-workbench/check-schema-text")>(
    "@/lib/schema-workbench/check-schema-text"
  );
  return {
    ...actual,
    checkSchemaText: (text: string) => (gate.hold ? gate.hold(text) : actual.checkSchemaText(text)),
  };
});

beforeEach(() => {
  gate.hold = null;
});

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

function paste(text: string) {
  fireEvent.change(screen.getByTestId("workbench-paste-textarea"), { target: { value: text } });
}

const status = () => screen.getByTestId("workbench-paste-status");
const review = () => screen.getByTestId("workbench-review-button") as HTMLButtonElement;

/** Paste and wait for the debounced check to settle on `state`. */
async function pasteAndSettle(text: string, state: "valid" | "invalid") {
  paste(text);
  await waitFor(() => expect(status().getAttribute("data-state")).toBe(state));
}

describe("SchemaWorkbench paste-first flow", () => {
  it("opens in paste mode with the tabs ordered Paste, Drop file, From URL, Build form", () => {
    setup({ onImportResult: vi.fn() });
    const tabs = ["paste", "drop", "url", "form"].map((id) => screen.getByTestId(`workbench-mode-${id}`));
    expect(tabs.map((t) => t.textContent)).toEqual(["Paste", "Drop file", "From URL", "Build form"]);
    expect(tabs[0].getAttribute("aria-pressed")).toBe("true");
    expect(tabs[1].getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("workbench-paste-textarea")).toBeDefined();
    expect(screen.queryByTestId("workbench-dropzone")).toBeNull();
  });

  it("has no Load schema button and no Detail Panel in paste mode", () => {
    setup();
    expect(screen.queryByTestId("workbench-load-button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load schema" })).toBeNull();
    expect(screen.queryByTestId("detail-panel-textarea")).toBeNull();
  });

  it("shows a hint without a state while the box is empty", () => {
    setup();
    expect(status().getAttribute("data-state")).toBeNull();
    expect(review().disabled).toBe(true);
  });

  it("pasting checks the text without loading it into the workbench", async () => {
    setup();
    await pasteAndSettle(AVRO, "valid");
    // Nothing was loaded: no import summary, no Detail Panel.
    expect(screen.queryByTestId("workbench-import-summary")).toBeNull();
    expect(screen.queryByTestId("detail-panel-textarea")).toBeNull();
  });

  it("goes from Checking to a valid answer once the debounce has passed", async () => {
    setup();
    paste(AVRO);
    expect(status().getAttribute("data-state")).toBe("checking");
    expect(status().textContent).toContain("Checking");
    await waitFor(() => expect(status().getAttribute("data-state")).toBe("valid"));
    expect(status().textContent).toMatch(/^Loads: Avro, entity Customer with 1 field/);
  });

  it("does not start the check before the debounce has elapsed", async () => {
    vi.useFakeTimers();
    setup();
    paste(AVRO);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(399);
    });
    expect(status().getAttribute("data-state")).toBe("checking");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await vi.waitFor(() => expect(status().getAttribute("data-state")).toBe("valid"));
  });

  it("restarts the debounce on every edit", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    gate.hold = async (text) => {
      seen.push(text);
      return { status: "empty" } satisfies SchemaTextCheck;
    };
    setup();
    paste("a");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    paste("ab");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(seen).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(seen).toEqual(["ab"]);
  });

  it("says why a schema cannot load", async () => {
    setup();
    await pasteAndSettle("just some words, not a schema", "invalid");
    expect(status().textContent).toMatch(/^Cannot load this schema: .+/);
  });

  it("returns to the hint when the box is cleared", async () => {
    setup();
    await pasteAndSettle(AVRO, "valid");
    paste("   ");
    expect(status().getAttribute("data-state")).toBeNull();
    expect(status().textContent).toMatch(/Paste a schema/);
    expect(review().disabled).toBe(true);
  });

  it("keeps Review & Import disabled while checking and when invalid, and enables it when valid", async () => {
    setup();
    expect(review().disabled).toBe(true);

    paste("not a schema");
    expect(status().getAttribute("data-state")).toBe("checking");
    expect(review().disabled).toBe(true);
    await waitFor(() => expect(status().getAttribute("data-state")).toBe("invalid"));
    expect(review().disabled).toBe(true);

    paste(AVRO);
    expect(review().disabled).toBe(true);
    await waitFor(() => expect(status().getAttribute("data-state")).toBe("valid"));
    expect(review().disabled).toBe(false);
  });

  it("commits the pasted text with no filename and an undetected format", async () => {
    const { onCommit } = setup();
    await pasteAndSettle(AVRO, "valid");
    fireEvent.click(review());
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(AVRO, undefined);
    expect(onCommit.mock.calls[0]).toHaveLength(2);
  });

  it("does not commit while the text is invalid", async () => {
    const { onCommit } = setup();
    await pasteAndSettle("nope", "invalid");
    fireEvent.click(review());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("re-checks after an edit to a valid schema", async () => {
    setup();
    await pasteAndSettle(AVRO, "valid");

    paste(AVRO.slice(0, AVRO.length - 4));
    expect(status().getAttribute("data-state")).toBe("checking");
    expect(review().disabled).toBe(true);
    await waitFor(() => expect(status().getAttribute("data-state")).toBe("invalid"));
    expect(review().disabled).toBe(true);

    paste(AVRO.replace("Customer", "Client"));
    await waitFor(() => expect(status().getAttribute("data-state")).toBe("valid"));
    expect(status().textContent).toContain("Client");
  });

  it("ignores a stale answer for older text", async () => {
    const pending = new Map<string, (r: SchemaTextCheck) => void>();
    gate.hold = (text) => new Promise((resolve) => pending.set(text, resolve as (r: SchemaTextCheck) => void));
    vi.useFakeTimers();
    setup();

    paste("first");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect([...pending.keys()]).toEqual(["first"]);

    // The text changes while the first answer is still outstanding.
    paste("second");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect([...pending.keys()]).toEqual(["first", "second"]);

    // The older answer arrives while the newer one is outstanding: it must not show, nor enable Review.
    await act(async () => {
      pending.get("first")!({ status: "valid", format: "avro", summary: "Avro, stale", warnings: 0, deferred: false });
    });
    expect(status().getAttribute("data-state")).toBe("checking");
    expect(review().disabled).toBe(true);

    await act(async () => {
      pending.get("second")!({ status: "invalid", message: "second is broken" });
    });
    expect(status().getAttribute("data-state")).toBe("invalid");
    expect(status().textContent).toContain("second is broken");
    expect(review().disabled).toBe(true);
  });

  it("ignores an older answer that arrives after the newer one", async () => {
    const pending = new Map<string, (r: SchemaTextCheck) => void>();
    gate.hold = (text) => new Promise((resolve) => pending.set(text, resolve as (r: SchemaTextCheck) => void));
    vi.useFakeTimers();
    setup();

    paste("first");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    paste("second");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    await act(async () => {
      pending.get("second")!({ status: "invalid", message: "second is broken" });
    });
    await act(async () => {
      pending.get("first")!({ status: "valid", format: "avro", summary: "Avro, stale", warnings: 0, deferred: false });
    });
    expect(status().getAttribute("data-state")).toBe("invalid");
    expect(status().textContent).not.toContain("stale");
    expect(review().disabled).toBe(true);
  });

  it("mentions the importer's warnings in the valid answer", async () => {
    setup();
    await pasteAndSettle(
      JSON.stringify({ title: "T", type: "object", properties: { y: {} } }),
      "valid"
    );
    expect(status().textContent).toMatch(/\(1 warning on review\)/);
  });

  it("shows the Detail Panel column again in Drop file mode", () => {
    setup();
    expect(screen.queryByTestId("detail-panel-textarea")).toBeNull();
    fireEvent.click(screen.getByTestId("workbench-mode-drop"));
    expect(screen.getByTestId("detail-panel-textarea")).toBeDefined();
    expect(screen.getByTestId("workbench-dropzone")).toBeDefined();
    expect(screen.queryByTestId("workbench-paste-status")).toBeNull();
  });

  it("loads a chosen file into the Detail Panel and commits it with its filename", async () => {
    const { onCommit } = setup();
    fireEvent.click(screen.getByTestId("workbench-mode-drop"));
    const input = screen.getByTestId("workbench-file-input");
    fireEvent.change(input, { target: { files: [new File([AVRO], "customer.avsc")] } });
    await waitFor(() =>
      expect((screen.getByTestId("detail-panel-textarea") as HTMLTextAreaElement).value).toBe(AVRO)
    );
    fireEvent.click(review());
    expect(onCommit).toHaveBeenCalledWith(AVRO, undefined, "customer.avsc");
  });

  it("keeps the pasted text and its answer when switching away and back", async () => {
    setup();
    await pasteAndSettle(AVRO, "valid");
    fireEvent.click(screen.getByTestId("workbench-mode-drop"));
    // Review in Drop mode follows the loaded schema (none), not the pasted text.
    expect(review().disabled).toBe(true);
    fireEvent.click(screen.getByTestId("workbench-mode-paste"));
    expect(status().getAttribute("data-state")).toBe("valid");
    expect((screen.getByTestId("workbench-paste-textarea") as HTMLTextAreaElement).value).toBe(AVRO);
    expect(review().disabled).toBe(false);
  });

  it("commits the pasted text, not an earlier dropped file, when Review is clicked in Paste mode", async () => {
    const { onCommit } = setup();
    fireEvent.click(screen.getByTestId("workbench-mode-drop"));
    const other = AVRO.replace("Customer", "Dropped");
    fireEvent.change(screen.getByTestId("workbench-file-input"), { target: { files: [new File([other], "d.avsc")] } });
    await waitFor(() => expect(screen.getByTestId("detail-panel-textarea")).toBeDefined());
    fireEvent.click(screen.getByTestId("workbench-mode-paste"));
    await pasteAndSettle(AVRO, "valid");
    fireEvent.click(review());
    expect(onCommit).toHaveBeenCalledWith(AVRO, undefined);
  });

  it("does not run the check after the workbench unmounts mid-debounce", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    gate.hold = async (text) => {
      seen.push(text);
      return { status: "empty" } satisfies SchemaTextCheck;
    };
    render(<SchemaWorkbench onCommit={vi.fn()} onBack={vi.fn()} />);
    paste(AVRO);
    cleanup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(seen).toEqual([]);
  });

  it("disables Review & Import and shows Parsing... while loading", async () => {
    const { onCommit } = setup({ isLoading: true });
    await pasteAndSettle(AVRO, "valid");
    expect(review().disabled).toBe(true);
    expect(review().textContent).toBe("Parsing...");
    fireEvent.click(review());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("enables Review & Import again when loading ends", async () => {
    const onCommit = vi.fn();
    const { rerender } = render(<SchemaWorkbench onCommit={onCommit} onBack={vi.fn()} isLoading />);
    await pasteAndSettle(AVRO, "valid");
    expect(review().disabled).toBe(true);
    rerender(<SchemaWorkbench onCommit={onCommit} onBack={vi.fn()} isLoading={false} />);
    expect(review().disabled).toBe(false);
    expect(review().textContent).toBe("Review & Import");
  });
});
