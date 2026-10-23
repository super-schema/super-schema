// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SchemaWorkbench } from "@/components/custom/SchemaWorkbench";
import type { TypeSpecImportResult } from "@/lib/importers/typespec.importer";

const importAction = vi.hoisted(() => vi.fn());
const control = vi.hoisted(() => ({ reject: false }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/jsonschema-url-import-actions", () => ({
  // A plain wrapper (not the spy itself): vitest's spy bookkeeping reports a rejecting spy as an unhandled error of the test.
  importJsonSchemaFromUrlAction: (...args: unknown[]) =>
    control.reject ? Promise.reject(new Error("boom")) : importAction(...args),
}));

beforeEach(() => {
  importAction.mockReset();
  control.reject = false;
});
afterEach(cleanup);

const GOOD = "https://github.paypal.com/org/repo/blob/main/schemas/order.json";

function resultWithDangling(): TypeSpecImportResult {
  return {
    models: [
      {
        name: "Order",
        fields: [
          {
            name: "owner",
            type: "reference",
            danglingRef: { ref: "./Owner.json", resolvedUri: "https://x/Owner.json", reason: "could not be fetched (404)" },
          },
        ],
      },
    ],
    sharedEnums: [],
    customScalars: [],
    unions: [],
    services: [],
    decoratorDefinitions: [],
    warnings: ["Unreachable reference ./Owner.json"],
    sourceFormat: "json-schema",
  } as unknown as TypeSpecImportResult;
}

function setup(props: Partial<React.ComponentProps<typeof SchemaWorkbench>> = {}) {
  const onImportResult = vi.fn();
  const utils = render(
    <SchemaWorkbench onCommit={vi.fn()} onBack={vi.fn()} onImportResult={onImportResult} {...props} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "From URL" }));
  return { onImportResult, ...utils };
}

const input = () => screen.getByTestId("workbench-url-input") as HTMLInputElement;
const button = () => screen.getByTestId("workbench-url-fetch-button") as HTMLButtonElement;
const type = (v: string) => fireEvent.change(input(), { target: { value: v } });

describe("SchemaWorkbench - From URL mode", () => {
  it("shows the URL input, helper note and a labeled field after switching mode", () => {
    setup();
    expect(input().getAttribute("aria-label")).toBe("Schema URL");
    expect(input().getAttribute("inputmode")).toBe("url");
    expect(screen.getByText(/Only https URLs are fetched/)).toBeTruthy();
  });

  it("is not offered when no import handler is wired", () => {
    render(<SchemaWorkbench onCommit={vi.fn()} onBack={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "From URL" })).toBeNull();
  });

  it.each([
    ["", /enter the url/i],
    ["   ", /enter the url/i],
    ["not a url", /http/i],
    ["ftp://example.com/a.json", /http/i],
    [`https://example.com/${"a".repeat(3000)}`, /2048/],
  ])("rejects %j client-side without calling the action", (value, message) => {
    setup();
    type(value);
    fireEvent.click(button());
    expect(screen.getByTestId("workbench-url-error").textContent).toMatch(message);
    expect(screen.getByTestId("workbench-url-error").getAttribute("role")).toBe("alert");
    expect(importAction).not.toHaveBeenCalled();
  });

  it("calls the action with exactly the trimmed URL and hands the result to the review path", async () => {
    const data = resultWithDangling();
    importAction.mockResolvedValue({ success: true, data });
    const { onImportResult } = setup();
    type(`  ${GOOD}  `);
    fireEvent.click(button());
    await waitFor(() => expect(onImportResult).toHaveBeenCalledTimes(1));
    expect(importAction).toHaveBeenCalledWith(GOOD);
    expect(importAction.mock.calls[0]).toHaveLength(1);
    expect(onImportResult.mock.calls[0][0]).toBe(data);
    expect(onImportResult.mock.calls[0][0].models[0].fields[0].danglingRef.reason).toMatch(/404/);
    await waitFor(() => expect(button().disabled).toBe(false));
  });

  it("disables the button and shows the status while loading", async () => {
    let resolve!: (v: unknown) => void;
    importAction.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    type(GOOD);
    fireEvent.click(button());
    expect(button().disabled).toBe(true);
    expect(screen.getByTestId("workbench-url-status").textContent).toContain("Fetching and resolving references");
    await act(async () => resolve({ success: false, error: { message: "nope" } }));
    expect(button().disabled).toBe(false);
    expect(screen.queryByTestId("workbench-url-status")).toBeNull();
  });

  it("shows the action's sanitized error as text and re-enables the button", async () => {
    importAction.mockResolvedValue({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "<b>Refused</b>: host is not allowed" },
    });
    const { onImportResult } = setup();
    type("http://127.0.0.1:9/x.json");
    fireEvent.click(button());
    const err = await screen.findByTestId("workbench-url-error");
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).toContain("<b>Refused</b>: host is not allowed");
    expect(err.querySelector("b")).toBeNull();
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(onImportResult).not.toHaveBeenCalled();
  });

  it("shows a generic error (not the exception text) when the action misbehaves", async () => {
    // A malformed result makes the handler itself throw (a TypeError): the user sees a generic message.
    importAction.mockResolvedValue(undefined);
    setup();
    type(GOOD);
    fireEvent.click(button());
    const err = await screen.findByTestId("workbench-url-error");
    expect(err.textContent).toMatch(/failed unexpectedly/);
    expect(err.textContent).not.toMatch(/undefined|Cannot read/);
    await waitFor(() => expect(button().disabled).toBe(false));
  });

  it("shows the sanitized error when the action rejects (network failure)", async () => {
    control.reject = true; // the action's promise rejects (as a failed network call does)
    const { onImportResult } = setup();
    type(GOOD);
    fireEvent.click(button());
    const err = await screen.findByTestId("workbench-url-error");
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).not.toContain("boom");
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(onImportResult).not.toHaveBeenCalled();
  });

  it("ignores a late result after the user clicks Build form", async () => {
    let resolve!: (v: unknown) => void;
    importAction.mockReturnValue(new Promise((r) => (resolve = r)));
    const { onImportResult } = setup();
    type(GOOD);
    fireEvent.click(button());
    fireEvent.click(screen.getByRole("button", { name: "Build form" }));
    await act(async () => resolve({ success: true, data: resultWithDangling() }));
    expect(onImportResult).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workbench-url-input")).toBeNull();
    expect(screen.getByRole("button", { name: "Build form" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("abandons a pending fetch when Build form asks to discard an import, and once that is confirmed", async () => {
    let resolve!: (v: unknown) => void;
    importAction.mockReturnValue(new Promise((r) => (resolve = r)));
    const { onImportResult } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    fireEvent.change(screen.getByTestId("workbench-paste-textarea"), {
      target: { value: '{"type":"record","name":"C","fields":[{"name":"id","type":"long"}]}' },
    });
    fireEvent.click(screen.getByTestId("workbench-load-button"));
    await waitFor(() => expect((screen.getByTestId("detail-panel-textarea") as HTMLTextAreaElement).value).not.toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "From URL" }));
    type(GOOD);
    fireEvent.click(button());
    fireEvent.click(screen.getByRole("button", { name: "Build form" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard import" }));
    await act(async () => resolve({ success: true, data: resultWithDangling() }));
    expect(onImportResult).not.toHaveBeenCalled();
  });

  async function loadImportThenStartFetch() {
    let resolve!: (v: unknown) => void;
    importAction.mockReturnValue(new Promise((r) => (resolve = r)));
    const utils = setup();
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    fireEvent.change(screen.getByTestId("workbench-paste-textarea"), {
      target: { value: '{"type":"record","name":"C","fields":[{"name":"id","type":"long"}]}' },
    });
    fireEvent.click(screen.getByTestId("workbench-load-button"));
    await waitFor(() => expect((screen.getByTestId("detail-panel-textarea") as HTMLTextAreaElement).value).not.toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "From URL" }));
    type(GOOD);
    fireEvent.click(button());
    return { ...utils, resolve };
  }

  it("ignores a late result when a dropped file replaces the schema while the fetch is in flight", async () => {
    let resolve!: (v: unknown) => void;
    importAction.mockReturnValue(new Promise((r) => (resolve = r)));
    const { onImportResult } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Drop file" }));
    const file = new File(['{"type":"record","name":"C","fields":[{"name":"id","type":"long"}]}'], "c.avsc", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("workbench-file-input"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "From URL" }));
    type(GOOD);
    fireEvent.click(button());
    expect(button().disabled).toBe(true);
    // the file finishes reading AFTER the fetch started
    await waitFor(() => expect((screen.getByTestId("detail-panel-textarea") as HTMLTextAreaElement).value).not.toBe(""));
    await act(async () => resolve({ success: true, data: resultWithDangling() }));
    expect(onImportResult).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false);
  });

  it("a double Enter in the URL box fetches once", async () => {
    let resolve!: (v: unknown) => void;
    importAction.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    type(GOOD);
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(importAction).toHaveBeenCalledTimes(1));
    await act(async () => resolve({ success: false, error: { message: "nope" } }));
    expect(button().disabled).toBe(false);
    expect(importAction).toHaveBeenCalledTimes(1);
  });

  it("ignores a late result after Start over", async () => {
    const { onImportResult, resolve } = await loadImportThenStartFetch();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    await act(async () => resolve({ success: true, data: resultWithDangling() }));
    expect(onImportResult).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false);
  });

  it("keeps the fetch alive when the discard confirmation of Build form is cancelled", async () => {
    const { onImportResult, resolve } = await loadImportThenStartFetch();
    fireEvent.click(screen.getByRole("button", { name: "Build form" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(button().disabled).toBe(true);
    const data = resultWithDangling();
    await act(async () => resolve({ success: true, data }));
    expect(onImportResult).toHaveBeenCalledTimes(1);
    expect(onImportResult.mock.calls[0][0]).toBe(data);
  });

  it("ignores a late result after switching mode", async () => {
    let resolve!: (v: unknown) => void;
    importAction.mockReturnValue(new Promise((r) => (resolve = r)));
    const { onImportResult } = setup();
    type(GOOD);
    fireEvent.click(button());
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    await act(async () => resolve({ success: true, data: resultWithDangling() }));
    expect(onImportResult).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "From URL" }));
    expect(button().disabled).toBe(false);
    expect(screen.queryByTestId("workbench-url-status")).toBeNull();
  });

  it("ignores a late result after unmount without a state-update warning", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolve!: (v: unknown) => void;
    importAction.mockReturnValue(new Promise((r) => (resolve = r)));
    const { onImportResult, unmount } = setup();
    type(GOOD);
    fireEvent.click(button());
    unmount();
    await act(async () => resolve({ success: true, data: resultWithDangling() }));
    expect(onImportResult).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("never renders the URL as a link and does not log it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    importAction.mockResolvedValue({ success: false, error: { message: "refused" } });
    const { container } = setup();
    type(GOOD);
    fireEvent.click(button());
    await screen.findByTestId("workbench-url-error");
    expect(container.querySelector("a")).toBeNull();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
