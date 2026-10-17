// @vitest-environment jsdom
// tests/unit/components/events/import-asyncapi-dialog.test.tsx
// The AsyncAPI importer's dialog (plan 2026-10-16-events-import-and-json-validation, WP-I3): document → review → import, opened from
// the New Event dialog's "Import existing…" link. The two server actions are mocked; what is pinned here is what the user sees and what
// the dialog sends.
import { useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  preview: vi.fn(), importAction: vi.fn(), createEventAction: vi.fn(), invalidate: vi.fn(), toastSuccess: vi.fn(), order: [] as string[],
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({
  createEventAction: h.createEventAction, previewAsyncApiImportAction: h.preview, importAsyncApiAction: h.importAction,
}));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => h.invalidate }));
vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, error: vi.fn() } }));

import { ImportAsyncApiDialog } from "@/features/events/workspace/ImportAsyncApiDialog";
import { NewEventDialog } from "@/features/events/workspace/NewEventDialog";
import {
  ERROR_HEADLINES, IMPORT_WARNING_LABELS, omittedWarningsCount, OMITTED_WARNINGS_PATTERN, OUTCOME_UNKNOWN, PROBLEMS_SHOWN_CAP, warningGroupLabel,
} from "@/features/events/workspace/import-labels";
import { failureOf, IMPORT_STALL_MS, useAsyncApiImport } from "@/features/events/workspace/use-asyncapi-import";
import type { ImportErrorCode, ImportWarning, ImportWarningCode } from "@/lib/events/import/types";
import { MAX_PARSER_PROBLEMS } from "@/services/events/import-limits";
import type { AsyncApiImportPreview } from "@/services/events/asyncapi-import.service";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const RAW_DB_TEXT = "Invalid `prisma.entity.create()` invocation in /app/src/services/imported-entities.ts:88 — Can't reach database server at `localhost:5432`";
/** The client-side limit (UTF-8 bytes): under the server's 1 MiB, because Next refuses a server action's request body of about 1 MB. */
const LIMIT = 800_000;
const TOO_LARGE = "The document is larger than 800 KB. Split it or remove unused components.";
const DOC = "asyncapi: 3.0.0\ninfo:\n  title: Streetlights Kafka API\n  version: 1.0.0\n";

const PREVIEW: AsyncApiImportPreview = {
  eventName: "Streetlights-Kafka-API", title: "Streetlights Kafka API",
  counts: { servers: 2, channels: 4, messages: 3, operations: 5, traits: 2, securitySchemes: 1 },
  entities: [
    { requestedName: "LightMeasured", name: "LightMeasured", renamed: false, fields: 2, format: "json-schema" },
    { requestedName: "TurnOnOff", name: "TurnOnOff2", renamed: true, fields: 1, format: "avro" },
    { requestedName: "Orphan", name: "Orphan", renamed: false, fields: 0, format: "placeholder" },
  ],
  builtInTraits: ["CloudEvents"],
  warnings: [
    { pointer: "/components/messages/orphan", code: "NO_PAYLOAD", message: 'The message "orphan" has no payload' },
    { pointer: "/components/messages/turnOnOff/payload", code: "ENTITY_RENAMED", message: 'The entity "TurnOnOff" was renamed to "TurnOnOff2"' },
    { pointer: "/servers/mtls/security/0", code: "DROPPED_CONSTRUCT", message: "The security scheme X509 is not supported" },
    { pointer: "/info/x-owner", code: "UNSUPPORTED_EXTENSION", message: 'The extension "x-owner" is not imported' },
  ],
};
const IMPORTED = { eventId: "ev1", preview: PREVIEW };

function setup() {
  const onOpenChange = vi.fn();
  const onImported = vi.fn((id: string) => void h.order.push(`imported:${id}`));
  render(<ImportAsyncApiDialog productId="p1" open onOpenChange={onOpenChange} onImported={onImported} />);
  return { onOpenChange, onImported };
}

const documentBox = () => screen.getByTestId("import-content") as HTMLTextAreaElement;
const fileInput = () => screen.getByTestId("import-file") as HTMLInputElement;
const previewButton = () => screen.getByTestId("import-preview") as HTMLButtonElement;
const cancelButton = () => screen.getByTestId("import-cancel") as HTMLButtonElement;
const backButton = () => screen.getByTestId("import-back") as HTMLButtonElement;
const importButton = () => screen.getByTestId("import-submit") as HTMLButtonElement;
const nameInput = () => screen.getByTestId("import-event-name") as HTMLInputElement;
const form = () => screen.getByTestId("import-form");
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const stepText = () => screen.getByTestId("import-step").textContent;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Pastes DOC and previews it; resolves on the review step. */
async function toReview() {
  type(documentBox(), DOC);
  fireEvent.click(previewButton());
  await screen.findByTestId("import-step-review");
}

/** From the review: Import, and wait for the failure panel. */
async function importAndFail() {
  fireEvent.click(importButton());
  await screen.findByTestId("import-failure");
}

const problems = (n: number) => Array.from({ length: n }, (_, i) => ({ pointer: `/channels/c${i}`, message: `problem ${i}`, code: "asyncapi-x" }));

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.invalidate.mockImplementation(() => void h.order.push("invalidate"));
  h.toastSuccess.mockImplementation(() => void h.order.push("toast"));
  h.preview.mockResolvedValue({ success: true, data: PREVIEW });
  h.importAction.mockResolvedValue({ success: true, data: IMPORTED });
  h.createEventAction.mockResolvedValue({ success: true, data: { id: "ev9" } });
});
afterEach(() => cleanup());

describe("ImportAsyncApiDialog: step 1, the document", () => {
  it("is a labelled dialog with a labelled text box, a labelled file control and a step indicator", () => {
    setup();
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Import an AsyncAPI document" })).toBeDefined();
    expect(screen.getByLabelText("AsyncAPI document")).toBe(documentBox());
    expect(screen.getByLabelText("Upload file")).toBe(fileInput());
    expect(documentBox().getAttribute("aria-describedby")).toContain("import-content-hint");
    expect(stepText()).toBe("Step 1 of 3: Document");
    expect(screen.getByTestId("import-asyncapi-dialog")).toBeDefined();
  });

  it("takes .yaml, .yml and .json files, and says what it reads", () => {
    setup();
    expect(fileInput().type).toBe("file");
    expect(fileInput().getAttribute("accept")).toBe(".yaml,.yml,.json");
    expect(screen.getByTestId("import-content-hint").textContent).toMatch(/AsyncAPI 3\.0/);
    expect(screen.getByTestId("import-content-hint").textContent).toMatch(/800 KB/);
  });

  it("puts the focus on the text box", async () => {
    setup();
    await waitFor(() => expect(document.activeElement).toBe(documentBox()));
  });

  it("Preview is disabled while the box is empty or only whitespace, and enabled once there is text", () => {
    setup();
    expect(previewButton().disabled).toBe(true);
    type(documentBox(), "  \n ");
    expect(previewButton().disabled).toBe(true);
    type(documentBox(), DOC);
    expect(previewButton().disabled).toBe(false);
    type(documentBox(), "");
    expect(previewButton().disabled).toBe(true);
    fireEvent.submit(form());
    expect(h.preview).not.toHaveBeenCalled();
  });

  it("Cancel and Escape close the dialog", () => {
    const { onOpenChange } = setup();
    fireEvent.click(cancelButton());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("ImportAsyncApiDialog: uploading a file", () => {
  it("reads the file into the text box, where it can still be edited", async () => {
    setup();
    fireEvent.change(fileInput(), { target: { files: [new File([DOC], "streetlights.yaml", { type: "application/yaml" })] } });
    await waitFor(() => expect(documentBox().value).toBe(DOC));
    expect(previewButton().disabled).toBe(false);
    type(documentBox(), `${DOC}# edited\n`);
    expect(documentBox().value).toBe(`${DOC}# edited\n`);
    expect(screen.queryByTestId("import-error")).toBeNull();
  });

  it("replaces what was in the box", async () => {
    setup();
    type(documentBox(), "old text");
    fireEvent.change(fileInput(), { target: { files: [new File([DOC], "a.json")] } });
    await waitFor(() => expect(documentBox().value).toBe(DOC));
  });

  it("sends the file's name with the preview and the import while the box still holds what the file held", async () => {
    setup();
    fireEvent.change(fileInput(), { target: { files: [new File([DOC], "streetlights.yaml")] } });
    await waitFor(() => expect(documentBox().value).toBe(DOC));
    fireEvent.click(previewButton());
    await screen.findByTestId("import-step-review");
    expect(h.preview).toHaveBeenCalledWith("p1", { content: DOC, fileName: "streetlights.yaml" });
    fireEvent.click(importButton());
    await waitFor(() => expect(h.importAction).toHaveBeenCalledTimes(1));
    expect(h.importAction).toHaveBeenCalledWith("p1", { content: DOC, fileName: "streetlights.yaml", eventName: "Streetlights-Kafka-API" });
  });

  it("does not send the name of a file whose text the user has since replaced", async () => {
    setup();
    fireEvent.change(fileInput(), { target: { files: [new File([DOC], "streetlights.yaml")] } });
    await waitFor(() => expect(documentBox().value).toBe(DOC));
    type(documentBox(), "asyncapi: 3.0.0\ninfo:\n  title: Something else\n");
    fireEvent.click(previewButton());
    await screen.findByTestId("import-step-review");
    expect(h.preview.mock.calls[0][1]).toEqual({ content: "asyncapi: 3.0.0\ninfo:\n  title: Something else\n" });
  });

  it("refuses a file over 800,000 bytes with the size message, reads nothing and calls no action", async () => {
    setup();
    type(documentBox(), "kept");
    const big = new File(["x"], "huge.yaml");
    Object.defineProperty(big, "size", { value: LIMIT + 1 });
    fireEvent.change(fileInput(), { target: { files: [big] } });
    const alert = await screen.findByTestId("import-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe(TOO_LARGE);
    expect(documentBox().value).toBe("kept");
    expect(h.preview).not.toHaveBeenCalled();
  });

  it("accepts a file of exactly 800,000 bytes", async () => {
    setup();
    const exact = new File([DOC], "exact.yaml");
    Object.defineProperty(exact, "size", { value: LIMIT });
    fireEvent.change(fileInput(), { target: { files: [exact] } });
    await waitFor(() => expect(documentBox().value).toBe(DOC));
    expect(screen.queryByTestId("import-error")).toBeNull();
  });

  it("clears the oversize message when new text follows", async () => {
    setup();
    const big = new File(["x"], "huge.yaml");
    Object.defineProperty(big, "size", { value: LIMIT + 1 });
    fireEvent.change(fileInput(), { target: { files: [big] } });
    await screen.findByTestId("import-error");
    type(documentBox(), DOC);
    expect(screen.queryByTestId("import-error")).toBeNull();
  });

  it("says 'The file is empty.' for an empty or blank file, and does not fill the box", async () => {
    setup();
    type(documentBox(), "kept");
    fireEvent.change(fileInput(), { target: { files: [new File([""], "empty.yaml")] } });
    const alert = await screen.findByTestId("import-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe("The file is empty.");
    expect(documentBox().value).toBe("kept");
    cleanup();

    setup();
    fireEvent.change(fileInput(), { target: { files: [new File(["  \n\t \n"], "blank.yaml")] } });
    expect((await screen.findByTestId("import-error")).textContent).toBe("The file is empty.");
    expect(documentBox().value).toBe("");
    expect(previewButton().disabled).toBe(true);
  });

  it("says 'The file could not be read' for a binary file, and does not fill the box (not 'larger than 800 KB' for one under the limit)", async () => {
    const binary = (length: number) => Uint8Array.from({ length }, (_, i) => [0x00, 0xff, 0xfe][i % 3]);
    setup();
    type(documentBox(), "kept");
    fireEvent.change(fileInput(), { target: { files: [new File([binary(3000)], "photo.yaml")] } });
    expect((await screen.findByTestId("import-error")).textContent).toBe("The file could not be read");
    expect(documentBox().value).toBe("kept");
    cleanup();

    // 790,000 bytes is under the limit; as text it would re-encode to more than 800,000 and be refused with the wrong reason
    setup();
    fireEvent.change(fileInput(), { target: { files: [new File([binary(790_000)], "big-binary.yaml")] } });
    expect((await screen.findByTestId("import-error")).textContent).toBe("The file could not be read");
    expect(documentBox().value).toBe("");
    expect(previewButton().disabled).toBe(true);
  });

  it("a normal file still loads, and the empty-file message goes when new text follows", async () => {
    setup();
    fireEvent.change(fileInput(), { target: { files: [new File([""], "empty.yaml")] } });
    await screen.findByTestId("import-error");
    fireEvent.change(fileInput(), { target: { files: [new File([DOC], "streetlights.yaml")] } });
    await waitFor(() => expect(documentBox().value).toBe(DOC));
    expect(screen.queryByTestId("import-error")).toBeNull();
    expect(previewButton().disabled).toBe(false);
  });

  it("says so when the file cannot be read", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = globalThis.FileReader;
    class BrokenReader {
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      result = null;
      readAsText() { queueMicrotask(() => this.onerror?.()); }
    }
    globalThis.FileReader = BrokenReader as unknown as typeof FileReader;
    try {
      setup();
      fireEvent.change(fileInput(), { target: { files: [new File([DOC], "a.yaml")] } });
      expect((await screen.findByTestId("import-error")).textContent).toBe("The file could not be read");
      expect(documentBox().value).toBe("");
    } finally {
      globalThis.FileReader = original;
      consoleError.mockRestore();
    }
  });
});

describe("ImportAsyncApiDialog: the preview request", () => {
  it("sends the pasted text and the product, and moves to the review", async () => {
    setup();
    await toReview();
    expect(h.preview).toHaveBeenCalledTimes(1);
    expect(h.preview).toHaveBeenCalledWith("p1", { content: DOC });
    expect(stepText()).toBe("Step 2 of 3: Review");
    expect(screen.queryByTestId("import-step-input")).toBeNull();
  });

  it("is single-flight: Preview says it is checking, is disabled, and a second submit is ignored", async () => {
    const pending = deferred<{ success: true; data: AsyncApiImportPreview }>();
    h.preview.mockReturnValue(pending.promise);
    setup();
    type(documentBox(), DOC);
    fireEvent.click(previewButton());
    expect(previewButton().disabled).toBe(true);
    expect(previewButton().textContent).toBe("Checking…");
    expect(documentBox().readOnly).toBe(true);
    fireEvent.submit(form());
    fireEvent.submit(form());
    expect(h.preview).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ success: true, data: PREVIEW }));
    await screen.findByTestId("import-step-review");
    expect(h.preview).toHaveBeenCalledTimes(1);
  });

  it("lets Escape close the dialog while it is only checking (a preview writes nothing)", async () => {
    h.preview.mockReturnValue(new Promise(() => {}));
    const { onOpenChange } = setup();
    type(documentBox(), DOC);
    fireEvent.click(previewButton());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("refuses pasted text over 800,000 bytes before asking the server, and accepts exactly 800,000", async () => {
    setup();
    type(documentBox(), "a".repeat(LIMIT + 1));
    fireEvent.click(previewButton());
    expect(screen.getByTestId("import-error").textContent).toBe(TOO_LARGE);
    expect(h.preview).not.toHaveBeenCalled();
    type(documentBox(), "a".repeat(LIMIT));
    expect(screen.queryByTestId("import-error")).toBeNull();
    fireEvent.click(previewButton());
    await screen.findByTestId("import-step-review");
    expect(h.preview).toHaveBeenCalledTimes(1);
  });

  it("measures pasted text in UTF-8 bytes, not characters: 400,001 two-byte characters are over, 400,000 are not", async () => {
    setup();
    type(documentBox(), "é".repeat(LIMIT / 2 + 1)); // 400,001 characters, 800,002 bytes
    fireEvent.click(previewButton());
    expect(screen.getByTestId("import-error").textContent).toBe(TOO_LARGE);
    expect(h.preview).not.toHaveBeenCalled();
    type(documentBox(), "漢".repeat(266_667)); // three bytes each: 800,001
    fireEvent.click(previewButton());
    expect(screen.getByTestId("import-error").textContent).toBe(TOO_LARGE);
    type(documentBox(), "é".repeat(LIMIT / 2)); // exactly 800,000 bytes
    fireEvent.click(previewButton());
    await screen.findByTestId("import-step-review");
    expect(h.preview).toHaveBeenCalledTimes(1);
  });

  it.each<[string, string, string | null]>([
    ["PARSE_ERROR", "The file is not valid YAML: Nested mappings are not allowed", "The document could not be read"],
    ["TOO_LARGE", "The AsyncAPI document is too large to import (1.2 MB); the limit is 1 MB", "The document is too large"],
    ["UNSUPPORTED_VERSION", "AsyncAPI 2.6.0 is not supported: only AsyncAPI 3.0 documents can be imported", "AsyncAPI 3.0 only"],
    ["EXTERNAL_REF", 'The reference "https://example.com/x.json" points outside the document', "The document refers to another file or a URL"],
    // a preview writes nothing: "The import failed" would be wrong for it
    ["IMPORT_FAILED", "The document could not be turned into an import plan", "The document could not be processed"],
    ["NOT_FOUND", 'Product "p1" not found', null],
  ])("a %s refusal stays on the document step, in an alert with the server's words", async (code, message, headline) => {
    h.preview.mockResolvedValue({ success: false, code, error: message, suggestedFix: "Fix it." });
    setup();
    type(documentBox(), DOC);
    fireEvent.click(previewButton());
    const alert = await screen.findByTestId("import-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("import-error-text").textContent).toBe(`${message} Fix it.`);
    if (headline) expect(screen.getByTestId("import-error-headline").textContent).toBe(headline);
    else expect(screen.queryByTestId("import-error-headline")).toBeNull();
    expect(stepText()).toBe("Step 1 of 3: Document");
    expect(documentBox().value).toBe(DOC);
    // and the text can be corrected and previewed again
    expect(previewButton().disabled).toBe(false);
  });

  it("never shows raw database text: a DB_ERROR or INTERNAL_ERROR is the generic message", async () => {
    h.preview.mockResolvedValue({ success: false, code: "DB_ERROR", error: RAW_DB_TEXT, suggestedFix: "Check DATABASE_URL" });
    setup();
    type(documentBox(), DOC);
    fireEvent.click(previewButton());
    expect((await screen.findByTestId("import-error-text")).textContent).toBe(GENERIC_ACTION_ERROR);
    expect(document.body.textContent).not.toMatch(/prisma|database server|localhost|DATABASE_URL/);
  });

  it("shows the generic message when the action throws, and the text can be previewed again", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    h.preview.mockRejectedValueOnce(new Error(RAW_DB_TEXT));
    setup();
    type(documentBox(), DOC);
    fireEvent.click(previewButton());
    expect((await screen.findByTestId("import-error-text")).textContent).toBe(GENERIC_ACTION_ERROR);
    expect(document.body.textContent).not.toMatch(/prisma|database server/);
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    fireEvent.click(previewButton());
    await screen.findByTestId("import-step-review");
    expect(screen.queryByTestId("import-error")).toBeNull();
    consoleError.mockRestore();
  });

  it("clears an earlier refusal as soon as the text changes", async () => {
    h.preview.mockResolvedValueOnce({ success: false, code: "PARSE_ERROR", error: "The file is empty" });
    setup();
    type(documentBox(), DOC);
    fireEvent.click(previewButton());
    await screen.findByTestId("import-error");
    type(documentBox(), `${DOC}x`);
    expect(screen.queryByTestId("import-error")).toBeNull();
  });
});

describe("ImportAsyncApiDialog: step 2, the review", () => {
  it("prefills the resolved event name, labelled, with the focus on it", async () => {
    setup();
    await toReview();
    expect(screen.getByLabelText("Event name")).toBe(nameInput());
    expect(nameInput().value).toBe("Streetlights-Kafka-API");
    expect(nameInput().getAttribute("aria-required")).toBe("true");
    expect(nameInput().getAttribute("aria-describedby")).toContain("import-event-name-hint");
    expect(screen.getByTestId("import-title").textContent).toBe("From the document “Streetlights Kafka API”");
    await waitFor(() => expect(document.activeElement).toBe(nameInput()));
  });

  it("shows the resolved name the server chose (a taken name was already made unique)", async () => {
    h.preview.mockResolvedValue({ success: true, data: { ...PREVIEW, eventName: "Streetlights-Kafka-API2" } });
    setup();
    await toReview();
    expect(nameInput().value).toBe("Streetlights-Kafka-API2");
  });

  it("shows the counts the server returned", async () => {
    setup();
    await toReview();
    const counts = screen.getByTestId("import-counts");
    expect(counts.querySelectorAll("dd")).toHaveLength(6);
    for (const [key, value] of Object.entries(PREVIEW.counts)) expect(screen.getByTestId(`import-count-${key}`).textContent).toBe(String(value));
    expect(within(counts).getByText("Servers")).toBeDefined();
    expect(within(counts).getByText("Security schemes")).toBeDefined();
  });

  it("lists every entity with its final name, field count and format, and marks the renamed one", async () => {
    setup();
    await toReview();
    expect(screen.getByTestId("import-entities-heading").textContent).toBe("3 entities to create");
    const light = screen.getByTestId("import-entity-LightMeasured");
    expect(light.textContent).toContain("2 fields");
    expect(light.textContent).toContain("JSON Schema");
    expect(screen.queryByTestId("import-entity-renamed-LightMeasured")).toBeNull();
    const renamed = screen.getByTestId("import-entity-TurnOnOff2");
    expect(renamed.textContent).toContain("1 field");
    expect(renamed.textContent).toContain("Avro");
    expect(screen.getByTestId("import-entity-renamed-TurnOnOff2").textContent).toBe("Renamed");
    expect(renamed.textContent).toContain('The document asks for "TurnOnOff", but that name is taken in this product.');
    expect(screen.getByTestId("import-entity-Orphan").textContent).toContain("0 fields");
    expect(screen.getByTestId("import-entity-Orphan").textContent).toContain("Placeholder");
  });

  it("names the built-in message properties that will be used, and says nothing when there are none", async () => {
    setup();
    await toReview();
    expect(screen.getByTestId("import-builtin-traits").textContent).toBe("Built-in message properties used instead of copies: CloudEvents.");
    cleanup();
    h.preview.mockResolvedValue({ success: true, data: { ...PREVIEW, builtInTraits: [] } });
    setup();
    await toReview();
    expect(screen.queryByTestId("import-builtin-traits")).toBeNull();
  });

  it("says plainly that the entities are DRAFTS, that their published versions must be pinned, and why", async () => {
    setup();
    await toReview();
    const note = screen.getByTestId("import-drafts-note");
    expect(note.textContent).toContain(
      "The imported entities are drafts. Publish them, then pin their published versions in the event's messages. An event cannot be published while a message points to an unpublished entity.",
    );
  });

  it("shows the drafts note for any preview that lists at least one entity, even a single placeholder", async () => {
    h.preview.mockResolvedValue({ success: true, data: { ...PREVIEW, entities: [PREVIEW.entities[2]], warnings: [] } });
    setup();
    await toReview();
    expect(screen.getByTestId("import-drafts-note").textContent).toContain("The imported entities are drafts.");
  });

  it("leaves the drafts note out when no entity is created", async () => {
    h.preview.mockResolvedValue({ success: true, data: { ...PREVIEW, entities: [], warnings: [] } });
    setup();
    await toReview();
    expect(screen.queryByTestId("import-drafts-note")).toBeNull();
    expect(screen.getByTestId("import-entities-heading").textContent).toBe("0 entities to create");
    expect(screen.getByTestId("import-no-entities")).toBeDefined();
  });

  it("offers Back and Import, and no Cancel", async () => {
    setup();
    await toReview();
    expect(backButton().textContent).toBe("Back");
    expect(importButton().textContent).toBe("Import");
    expect(importButton().disabled).toBe(false);
    expect(screen.queryByTestId("import-preview")).toBeNull();
    expect(screen.queryByTestId("import-cancel")).toBeNull();
  });

  it("Back returns to the document with the text kept and the focus on the box", async () => {
    setup();
    await toReview();
    fireEvent.click(backButton());
    expect(stepText()).toBe("Step 1 of 3: Document");
    expect(documentBox().value).toBe(DOC);
    await waitFor(() => expect(document.activeElement).toBe(documentBox()));
    // previewing again replaces the review
    h.preview.mockResolvedValueOnce({ success: true, data: { ...PREVIEW, eventName: "Streetlights-Kafka-API3" } });
    fireEvent.click(previewButton());
    await screen.findByTestId("import-step-review");
    expect(nameInput().value).toBe("Streetlights-Kafka-API3");
  });
});

describe("ImportAsyncApiDialog: the warnings", () => {
  it("groups them by code under human labels, collapsed, with a total", async () => {
    setup();
    await toReview();
    expect(screen.getByTestId("import-warnings-count").textContent).toBe("4 warnings");
    for (const code of ["NO_PAYLOAD", "ENTITY_RENAMED", "DROPPED_CONSTRUCT", "UNSUPPORTED_EXTENSION"] as const) {
      const toggle = screen.getByTestId(`import-warning-group-${code}-toggle`);
      expect(toggle.textContent).toContain(IMPORT_WARNING_LABELS[code]);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(screen.getByTestId(`import-warning-group-${code}-count`).textContent).toBe("1");
    }
    expect(screen.queryByTestId("import-warning-group-NO_PAYLOAD-list")).toBeNull();
    expect(screen.queryByTestId("import-warning-group-KEY_ADJUSTED")).toBeNull();
  });

  it("shows the groups in the order of the labels, whatever order the server sent", async () => {
    setup();
    await toReview();
    const ids = Array.from(screen.getByTestId("import-warnings").querySelectorAll("li[data-testid^='import-warning-group-']"))
      .filter((el) => /^import-warning-group-[A-Z_]+$/.test(el.getAttribute("data-testid") ?? ""))
      .map((el) => el.getAttribute("data-testid"));
    expect(ids).toEqual([
      "import-warning-group-NO_PAYLOAD", "import-warning-group-UNSUPPORTED_EXTENSION", "import-warning-group-DROPPED_CONSTRUCT", "import-warning-group-ENTITY_RENAMED",
    ]);
  });

  it("expands a group to its messages, each with the pointer into the source file, and collapses it again", async () => {
    setup();
    await toReview();
    const toggle = screen.getByTestId("import-warning-group-DROPPED_CONSTRUCT-toggle");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByTestId("import-warning-group-DROPPED_CONSTRUCT-item");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("The security scheme X509 is not supported");
    expect(items[0].textContent).toContain("/servers/mtls/security/0");
    fireEvent.click(toggle);
    expect(screen.queryByTestId("import-warning-group-DROPPED_CONSTRUCT-list")).toBeNull();
  });

  it("calls a pointer of the whole document 'the document'", async () => {
    h.preview.mockResolvedValue({ success: true, data: { ...PREVIEW, warnings: [{ pointer: "", code: "ENTITY_RENAMED", message: 'The name "x" is taken' }] } });
    setup();
    await toReview();
    fireEvent.click(screen.getByTestId("import-warning-group-ENTITY_RENAMED-toggle"));
    expect(screen.getByTestId("import-warning-group-ENTITY_RENAMED-item").textContent).toContain("the document");
  });

  it("lists the first 20 of a group and the rest on request", async () => {
    const many: ImportWarning[] = Array.from({ length: 60 }, (_, i) => ({ pointer: `/components/schemas/s${i}`, code: "SANITIZED_VALUE", message: `value ${i} was removed` }));
    h.preview.mockResolvedValue({ success: true, data: { ...PREVIEW, warnings: many } });
    setup();
    await toReview();
    expect(screen.getByTestId("import-warnings-count").textContent).toBe("60 warnings");
    fireEvent.click(screen.getByTestId("import-warning-group-SANITIZED_VALUE-toggle"));
    expect(screen.getAllByTestId("import-warning-group-SANITIZED_VALUE-item")).toHaveLength(20);
    expect(screen.getByText("value 19 was removed")).toBeDefined();
    expect(screen.queryByText("value 20 was removed")).toBeNull();
    fireEvent.click(screen.getByTestId("import-warning-group-SANITIZED_VALUE-all"));
    expect(screen.getAllByTestId("import-warning-group-SANITIZED_VALUE-item")).toHaveLength(60);
    expect(screen.queryByTestId("import-warning-group-SANITIZED_VALUE-all")).toBeNull();
  });

  it("does not offer 'Show all' for a group of 20 or fewer", async () => {
    const twenty: ImportWarning[] = Array.from({ length: 20 }, (_, i) => ({ pointer: `/a/${i}`, code: "KEY_ADJUSTED", message: `key ${i} changed` }));
    h.preview.mockResolvedValue({ success: true, data: { ...PREVIEW, warnings: twenty } });
    setup();
    await toReview();
    fireEvent.click(screen.getByTestId("import-warning-group-KEY_ADJUSTED-toggle"));
    expect(screen.getAllByTestId("import-warning-group-KEY_ADJUSTED-item")).toHaveLength(20);
    expect(screen.queryByTestId("import-warning-group-KEY_ADJUSTED-all")).toBeNull();
  });

  it("shows the importer's 'N more warnings were omitted' line as a note: not a dropped construct, not counted", async () => {
    const warnings: ImportWarning[] = [
      { pointer: "/servers/mtls/security/0", code: "DROPPED_CONSTRUCT", message: "The security scheme X509 is not supported" },
      { pointer: "", code: "DROPPED_CONSTRUCT", message: "37 more warnings were omitted" },
    ];
    h.preview.mockResolvedValue({ success: true, data: { ...PREVIEW, warnings } });
    setup();
    await toReview();
    expect(screen.getByTestId("import-warning-group-DROPPED_CONSTRUCT-count").textContent).toBe("1");
    expect(screen.getByTestId("import-warnings-count").textContent).toBe("1 warning");
    fireEvent.click(screen.getByTestId("import-warning-group-DROPPED_CONSTRUCT-toggle"));
    const items = screen.getAllByTestId("import-warning-group-DROPPED_CONSTRUCT-item");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).not.toContain("omitted");
    expect(screen.getByTestId("import-warnings-omitted").textContent).toBe("37 more warnings were omitted from this list.");
  });

  it("keeps a dropped construct that is about the whole document (pointer \"\") in its group when it is not the summary line", async () => {
    const warnings: ImportWarning[] = [{ pointer: "", code: "DROPPED_CONSTRUCT", message: "The document has no defaultContentType, so none was imported" }];
    h.preview.mockResolvedValue({ success: true, data: { ...PREVIEW, warnings } });
    setup();
    await toReview();
    expect(screen.getByTestId("import-warning-group-DROPPED_CONSTRUCT-count").textContent).toBe("1");
    expect(screen.queryByTestId("import-warnings-omitted")).toBeNull();
  });

  it("says under the Warnings heading that warnings do not stop the import, and shows no such sentence when there are no warnings", async () => {
    setup();
    await toReview();
    const note = screen.getByTestId("import-warnings-note");
    expect(note.textContent).toBe("Warnings do not stop the import.");
    expect(screen.getByTestId("import-warnings").contains(note)).toBe(true);
    cleanup();
    h.preview.mockResolvedValue({ success: true, data: { ...PREVIEW, warnings: [] } });
    setup();
    await toReview();
    expect(screen.queryByTestId("import-warnings-note")).toBeNull();
  });

  it("shows no warnings section when there are none", async () => {
    h.preview.mockResolvedValue({ success: true, data: { ...PREVIEW, warnings: [] } });
    setup();
    await toReview();
    expect(screen.queryByTestId("import-warnings")).toBeNull();
  });

  it("shows a code this build does not know under its own name, after the known groups", async () => {
    const warnings = [
      { pointer: "/x", code: "BRAND_NEW_CODE", message: "something new" },
      { pointer: "/y", code: "KEY_ADJUSTED", message: "a key changed" },
    ] as unknown as ImportWarning[];
    h.preview.mockResolvedValue({ success: true, data: { ...PREVIEW, warnings } });
    setup();
    await toReview();
    const toggles = screen.getAllByTestId(/^import-warning-group-.*-toggle$/).map((el) => el.textContent);
    expect(toggles[0]).toContain(IMPORT_WARNING_LABELS.KEY_ADJUSTED);
    expect(toggles[1]).toContain("BRAND_NEW_CODE");
  });
});

describe("import-labels: warning and error wording", () => {
  // `Record<…, true>` makes this file fail to compile when the importer gains a code: add it here AND to the labels.
  const WARNING_CODES: Record<ImportWarningCode, true> = {
    UNSUPPORTED_PAYLOAD_FORMAT: true, NO_PAYLOAD: true, UNSUPPORTED_EXTENSION: true, DROPPED_CONSTRUCT: true, ENTITY_RENAMED: true,
    BUILTIN_TRAIT_MAPPED: true, KEY_ADJUSTED: true, SANITIZED_VALUE: true, VALIDATION_WARNING: true,
  };
  const ERROR_CODES: Record<ImportErrorCode, true> = {
    PARSE_ERROR: true, UNSUPPORTED_VERSION: true, TOO_LARGE: true, EXTERNAL_REF: true, REF_CYCLE: true, REF_NOT_FOUND: true, REF_TOO_LARGE: true,
    MISSING_PAYLOAD_PIN: true, VALIDATION_ERROR: true, IMPORT_FAILED: true,
  };

  it("has human wording for every warning code, never the code itself", () => {
    expect(Object.keys(IMPORT_WARNING_LABELS).sort()).toEqual(Object.keys(WARNING_CODES).sort());
    for (const code of Object.keys(WARNING_CODES)) {
      const label = warningGroupLabel(code);
      expect(label.length).toBeGreaterThan(10);
      expect(label).not.toBe(code);
      expect(label).not.toMatch(/^[A-Z_]+$/);
    }
  });

  it("has a first line for every importer error code, saying 'AsyncAPI 3.0 only' for a 2.x file", () => {
    expect(Object.keys(ERROR_HEADLINES).sort()).toEqual(Object.keys(ERROR_CODES).sort());
    expect(ERROR_HEADLINES.UNSUPPORTED_VERSION).toBe("AsyncAPI 3.0 only");
    for (const headline of Object.values(ERROR_HEADLINES)) expect(headline.length).toBeGreaterThan(10);
  });

  it("recognises exactly the importer's summary warning (pointer \"\", DROPPED_CONSTRUCT, 'N more warning(s) was/were omitted')", () => {
    const summary = (message: string, over: Partial<ImportWarning> = {}): ImportWarning => ({ pointer: "", code: "DROPPED_CONSTRUCT", message, ...over });
    expect(omittedWarningsCount(summary("5 more warnings were omitted"))).toBe(5);
    expect(omittedWarningsCount(summary("1 more warning was omitted"))).toBe(1);
    expect(omittedWarningsCount(summary("1234 more warnings were omitted"))).toBe(1234);
    // anything else is an ordinary warning
    expect(omittedWarningsCount(summary("5 more warnings were omitted", { pointer: "/info" }))).toBeNull();
    expect(omittedWarningsCount(summary("5 more warnings were omitted", { code: "SANITIZED_VALUE" }))).toBeNull();
    expect(omittedWarningsCount(summary("The 5 more warnings were omitted"))).toBeNull();
    expect(omittedWarningsCount(summary("more warnings were omitted"))).toBeNull();
    expect(omittedWarningsCount(summary("The channel was left out"))).toBeNull();
    expect(OMITTED_WARNINGS_PATTERN.test("2 more warnings were omitted")).toBe(true);
  });

  it("PROBLEMS_SHOWN_CAP is the number of problems the server stops at (MAX_PARSER_PROBLEMS), so 'at least N' is told at the right length", () => {
    expect(PROBLEMS_SHOWN_CAP).toBe(MAX_PARSER_PROBLEMS);
  });

  it("reads a failed action result into text, problems and leftovers, ignoring anything that is not that shape", () => {
    const failure = failureOf({
      error: "bad", code: "VALIDATION_ERROR", suggestedFix: "Fix it.",
      details: { problems: [{ pointer: "/a", message: "m1" }, { message: "m2" }, { pointer: "/c" }, "junk", null, { pointer: 5, message: "m3" }], leftovers: [{ kind: "entity", name: "E" }, { kind: "event" }, { kind: "other" }, 7] },
    });
    expect(failure.text).toBe("bad Fix it.");
    expect(failure.problems).toEqual([{ pointer: "/a", message: "m1" }, { pointer: "", message: "m2" }, { pointer: "", message: "m3" }]);
    expect(failure.leftovers).toEqual([{ kind: "entity", name: "E" }, { kind: "event", name: null }]);
    expect(failureOf({ error: "x", details: { problems: "nope", leftovers: {} } })).toMatchObject({ problems: [], leftovers: [] });
    expect(failureOf({ error: RAW_DB_TEXT, code: "INTERNAL_ERROR" }).text).toBe(GENERIC_ACTION_ERROR);
  });
});

describe("ImportAsyncApiDialog: a document that cannot be imported", () => {
  const refuse = (list = problems(3)) => h.preview.mockResolvedValue({
    success: false, code: "VALIDATION_ERROR", error: "The AsyncAPI document is not valid: problem 0 (at /channels/c0), and 2 more problems",
    details: { problems: list }, suggestedFix: "Fix the document and import it again.",
  });

  it("shows the diagnostics (message and pointer each) on the review step, and no Import button", async () => {
    refuse();
    setup();
    type(documentBox(), DOC);
    fireEvent.click(previewButton());
    await screen.findByTestId("import-problems-panel");
    expect(stepText()).toBe("Step 2 of 3: Review");
    expect(screen.getByRole("heading", { name: "This document cannot be imported" })).toBeDefined();
    expect(screen.getByTestId("import-problems-count").textContent).toBe("3 problems");
    const items = screen.getAllByTestId(/^import-problem-\d+$/);
    expect(items).toHaveLength(3);
    expect(items[1].textContent).toContain("problem 1");
    expect(items[1].textContent).toContain("/channels/c1");
    expect(screen.queryByTestId("import-submit")).toBeNull();
    expect(screen.queryByTestId("import-event-name")).toBeNull();
    expect(backButton()).toBeDefined();
    // it says nothing was created, in an alert
    expect(screen.getByText(/Nothing was created/).closest("[role='alert']")).not.toBeNull();
  });

  it("calls a problem of the whole document 'the document'", async () => {
    refuse([{ pointer: "", message: "info is required", code: "asyncapi-x" }]);
    setup();
    type(documentBox(), DOC);
    fireEvent.click(previewButton());
    await screen.findByTestId("import-problems-panel");
    expect(screen.getByTestId("import-problem-0").textContent).toContain("the document");
  });

  it("lists the first 50 problems and counts the rest", async () => {
    refuse(problems(80));
    setup();
    type(documentBox(), DOC);
    fireEvent.click(previewButton());
    await screen.findByTestId("import-problems-panel");
    expect(screen.getAllByTestId(/^import-problem-\d+$/)).toHaveLength(50);
    expect(screen.getByTestId("import-problem-49").textContent).toContain("problem 49");
    expect(screen.queryByTestId("import-problem-50")).toBeNull();
    expect(screen.getByTestId("import-problems-more").textContent).toBe("and 30 more not shown");
    expect(screen.getByTestId("import-problems-count").textContent).toBe("80 problems");
  });

  it("says 'at least 100 problems' for a list that is as long as the server's cap (the server cut it off), and counts 99 as 99", async () => {
    refuse(problems(99));
    setup();
    type(documentBox(), DOC);
    fireEvent.click(previewButton());
    await screen.findByTestId("import-problems-panel");
    expect(screen.getByTestId("import-problems-count").textContent).toBe("99 problems");
    cleanup();

    refuse(problems(PROBLEMS_SHOWN_CAP));
    setup();
    type(documentBox(), DOC);
    fireEvent.click(previewButton());
    await screen.findByTestId("import-problems-panel");
    expect(screen.getByTestId("import-problems-count").textContent).toBe("at least 100 problems");
    expect(screen.getByTestId("import-problems-more").textContent).toBe("and 50 more not shown");
  });

  it("does not show a 'more' line for 50 problems or fewer", async () => {
    refuse(problems(50));
    setup();
    type(documentBox(), DOC);
    fireEvent.click(previewButton());
    await screen.findByTestId("import-problems-panel");
    expect(screen.getAllByTestId(/^import-problem-\d+$/)).toHaveLength(50);
    expect(screen.queryByTestId("import-problems-more")).toBeNull();
  });

  it("puts the focus on Back, which returns to the text for a fix and a new preview", async () => {
    refuse();
    setup();
    type(documentBox(), DOC);
    fireEvent.click(previewButton());
    await screen.findByTestId("import-problems-panel");
    await waitFor(() => expect(document.activeElement).toBe(backButton()));
    fireEvent.click(backButton());
    expect(documentBox().value).toBe(DOC);
    h.preview.mockResolvedValue({ success: true, data: PREVIEW });
    fireEvent.click(previewButton());
    await screen.findByTestId("import-review");
    expect(screen.queryByTestId("import-problems-panel")).toBeNull();
  });

  it("a VALIDATION_ERROR without a list (the 500-entity limit, an oversize text) stays on the document step as an error", async () => {
    h.preview.mockResolvedValue({
      success: false, code: "VALIDATION_ERROR", error: "This document would create 501 entities; one import creates at most 500",
      details: { entities: 501, limit: 500 }, suggestedFix: "Split the document into several files and import them one by one.",
    });
    setup();
    type(documentBox(), DOC);
    fireEvent.click(previewButton());
    expect((await screen.findByTestId("import-error-text")).textContent).toContain("501 entities");
    expect(stepText()).toBe("Step 1 of 3: Document");
    expect(screen.queryByTestId("import-problems-panel")).toBeNull();
  });
});

describe("ImportAsyncApiDialog: the event name", () => {
  it("sends the name the user typed (trimmed) with the previewed text", async () => {
    setup();
    await toReview();
    type(nameInput(), "  my-streetlights  ");
    fireEvent.click(importButton());
    await waitFor(() => expect(h.importAction).toHaveBeenCalledTimes(1));
    expect(h.importAction).toHaveBeenCalledWith("p1", { content: DOC, eventName: "my-streetlights" });
  });

  it("sends the prefilled name when it is left alone", async () => {
    setup();
    await toReview();
    fireEvent.click(importButton());
    await waitFor(() => expect(h.importAction).toHaveBeenCalledTimes(1));
    expect(h.importAction.mock.calls[0][1].eventName).toBe("Streetlights-Kafka-API");
  });

  it("after Back, edited text needs a new preview, and that edited text is what is imported", async () => {
    setup();
    await toReview();
    fireEvent.click(backButton());
    type(documentBox(), "asyncapi: 3.0.0\ninfo:\n  title: Edited after the preview\n");
    // the review step is gone: going on needs a fresh preview of the edited text
    expect(h.importAction).not.toHaveBeenCalled();
    fireEvent.click(previewButton());
    await screen.findByTestId("import-review");
    fireEvent.click(importButton());
    await waitFor(() => expect(h.importAction).toHaveBeenCalledTimes(1));
    expect(h.importAction.mock.calls[0][1].content).toBe("asyncapi: 3.0.0\ninfo:\n  title: Edited after the preview\n");
  });

  it("asks for a name when the field is emptied, next to the field, in an alert, and sends nothing", async () => {
    setup();
    await toReview();
    type(nameInput(), "   ");
    importButton().focus(); // as a click on the button does in a browser
    fireEvent.click(importButton());
    await waitFor(() => expect(document.activeElement).toBe(nameInput())); // the refusal sends the user back to the field
    const error = screen.getByTestId("import-event-name-error");
    expect(error.textContent).toBe("Name is required.");
    expect(error.getAttribute("role")).toBe("alert");
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(nameInput().getAttribute("aria-describedby")).toContain("import-event-name-error");
    expect(h.importAction).not.toHaveBeenCalled();
    type(nameInput(), "x");
    expect(screen.queryByTestId("import-event-name-error")).toBeNull();
    expect(nameInput().getAttribute("aria-invalid")).toBeNull();
  });

  it("applies the service's own name rule before sending: a name with a space is refused with its message", async () => {
    setup();
    await toReview();
    type(nameInput(), "not a valid name!");
    fireEvent.click(importButton());
    expect(screen.getByTestId("import-event-name-error").textContent).toContain('Event name "not a valid name!" is invalid');
    expect(screen.getByTestId("import-event-name-error").textContent).toMatch(/letters, digits/i);
    // the message and its fix are two sentences, not one run-on line
    expect(screen.getByTestId("import-event-name-error").textContent).toMatch(/is invalid\. Use 1–128 letters/);
    expect(screen.getByTestId("import-event-name-error").textContent).not.toMatch(/\.\./);
    expect(h.importAction).not.toHaveBeenCalled();
    expect(stepText()).toBe("Step 2 of 3: Review");
  });

  it("imports on Enter in the name field (a form submit)", async () => {
    setup();
    await toReview();
    fireEvent.submit(form());
    await waitFor(() => expect(h.importAction).toHaveBeenCalledTimes(1));
  });
});

describe("ImportAsyncApiDialog: step 3, the import", () => {
  it("on success: a toast, the explorer tree refreshed, then the new event's id goes to the host", async () => {
    const { onImported, onOpenChange } = setup();
    await toReview();
    fireEvent.click(importButton());
    await waitFor(() => expect(onImported).toHaveBeenCalledWith("ev1"));
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(h.invalidate).toHaveBeenCalledTimes(1);
    expect(h.toastSuccess).toHaveBeenCalledWith('Imported "Streetlights-Kafka-API" with 3 draft entities');
    expect(h.order).toEqual(["toast", "invalidate", "imported:ev1"]);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("stays locked after a success (the host navigates away): nothing can import a second time or dismiss it", async () => {
    const { onImported, onOpenChange } = setup();
    await toReview();
    fireEvent.click(importButton());
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(screen.getByTestId("import-progress").getAttribute("data-state")).toBe("imported");
    expect(screen.getByTestId("import-progress").textContent).toContain("Opening the event");
    expect(importButton().disabled).toBe(true);
    expect(backButton().disabled).toBe(true);
    fireEvent.submit(form());
    fireEvent.click(importButton());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(h.importAction).toHaveBeenCalledTimes(1);
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("shows progress while it runs; Import and Back are disabled, the focus moves to the progress note, and a second submit does nothing", async () => {
    const pending = deferred<{ success: true; data: typeof IMPORTED }>();
    h.importAction.mockReturnValue(pending.promise);
    const { onImported } = setup();
    await toReview();
    fireEvent.click(importButton());
    expect(stepText()).toBe("Step 3 of 3: Import");
    expect(importButton().disabled).toBe(true);
    expect(importButton().textContent).toBe("Importing…");
    expect(backButton().disabled).toBe(true);
    const progress = screen.getByTestId("import-progress");
    expect(progress.getAttribute("role")).toBe("status");
    expect(progress.textContent).toContain("Importing…");
    await waitFor(() => expect(document.activeElement).toBe(progress));
    // Enter in the form and clicks on the disabled button: still one import
    act(() => {
      fireEvent.submit(form());
      fireEvent.submit(form());
      fireEvent.click(importButton());
    });
    expect(h.importAction).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ success: true, data: IMPORTED }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith("ev1"));
    expect(h.importAction).toHaveBeenCalledTimes(1);
  });

  it("two submits in one batch (a double click before React re-renders) still import once", async () => {
    const pending = deferred<{ success: true; data: typeof IMPORTED }>();
    h.importAction.mockReturnValue(pending.promise);
    setup();
    await toReview();
    act(() => {
      fireEvent.submit(form());
      fireEvent.submit(form());
    });
    expect(h.importAction).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ success: true, data: IMPORTED }));
  });

  it("Escape and a click on the X do nothing while the import runs; Escape works again after a failure", async () => {
    const pending = deferred<{ success: false; code: string; error: string }>();
    h.importAction.mockReturnValue(pending.promise);
    const { onOpenChange } = setup();
    await toReview();
    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
    fireEvent.click(importButton());
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ success: false, code: "IMPORT_FAILED", error: "The import failed." }));
    await screen.findByTestId("import-failure");
    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("on failure: the server's words in an alert, 'Nothing was created.', and Back and Try again", async () => {
    h.importAction.mockResolvedValue({
      success: false, code: "NAME_CONFLICT", error: '"Streetlights-Kafka-API" is already used by Event "Streetlights-Kafka-API" at Product level.', suggestedFix: "Pick another name.",
    });
    const { onImported } = setup();
    await toReview();
    await importAndFail();
    const failure = screen.getByTestId("import-failure");
    expect(failure.getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("import-failure-headline").textContent).toBe("The import failed");
    expect(screen.getByTestId("import-failure-text").textContent).toBe('"Streetlights-Kafka-API" is already used by Event "Streetlights-Kafka-API" at Product level. Pick another name.');
    expect(screen.getByTestId("import-nothing-created").textContent).toBe("Nothing was created.");
    expect(stepText()).toBe("Step 3 of 3: Import");
    expect(onImported).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(importButton().textContent).toBe("Try again");
    expect(importButton().disabled).toBe(false);
    expect(backButton().disabled).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(backButton()));
  });

  it("uses the headline of the error's code on a failed import (IMPORT_FAILED, VALIDATION_ERROR)", async () => {
    h.importAction.mockResolvedValue({ success: false, code: "IMPORT_FAILED", error: "The import failed. Nothing was imported: nothing had been created yet." });
    setup();
    await toReview();
    await importAndFail();
    expect(screen.getByTestId("import-failure-headline").textContent).toBe("The import failed");
    expect(screen.getByTestId("import-failure-text").textContent).toContain("Nothing was imported");
  });

  it("Back returns to the review with the name the user typed, and Import then sends it", async () => {
    h.importAction.mockResolvedValueOnce({ success: false, code: "NAME_CONFLICT", error: "taken" });
    setup();
    await toReview();
    type(nameInput(), "first-try");
    await importAndFail();
    fireEvent.click(backButton());
    expect(stepText()).toBe("Step 2 of 3: Review");
    expect(nameInput().value).toBe("first-try");
    await waitFor(() => expect(document.activeElement).toBe(nameInput()));
    type(nameInput(), "second-try");
    fireEvent.click(importButton());
    await waitFor(() => expect(h.importAction).toHaveBeenCalledTimes(2));
    expect(h.importAction.mock.calls[1][1].eventName).toBe("second-try");
  });

  it("Try again imports the same document under the same name, and a success then goes on as usual", async () => {
    h.importAction.mockResolvedValueOnce({ success: false, code: "IMPORT_FAILED", error: "The import failed." });
    const { onImported } = setup();
    await toReview();
    await importAndFail();
    fireEvent.click(importButton());
    await waitFor(() => expect(onImported).toHaveBeenCalledWith("ev1"));
    expect(h.importAction).toHaveBeenCalledTimes(2);
    expect(h.importAction.mock.calls[1]).toEqual(h.importAction.mock.calls[0]);
    expect(screen.queryByTestId("import-failure")).toBeNull();
  });

  it("names what could not be undone (and does not claim that nothing was created)", async () => {
    h.importAction.mockResolvedValue({
      success: false, code: "IMPORT_FAILED",
      error: 'The import failed. The import could not be undone completely: the entity "TurnOnOff2", the event it created are still in the product; delete them by hand.',
      details: { deletedEntities: 1, leftovers: [{ kind: "entity", id: "e1", name: "TurnOnOff2", code: "IN_USE", message: "in use" }, { kind: "event", id: "ev1", message: "gone wrong" }] },
    });
    setup();
    await toReview();
    type(nameInput(), "orders-events");
    await importAndFail();
    const leftovers = screen.getByTestId("import-leftovers");
    expect(leftovers.textContent).toContain("Some of what the import had created could not be removed again:");
    expect(within(leftovers).getAllByRole("listitem").map((li) => li.textContent)).toEqual(['The entity "TurnOnOff2"', 'The event "orders-events"']);
    expect(leftovers.textContent).toContain("Delete them by hand");
    expect(screen.queryByTestId("import-nothing-created")).toBeNull();
  });

  it("shows the generic message for a database failure, never the raw text", async () => {
    h.importAction.mockResolvedValue({ success: false, code: "DB_ERROR", error: RAW_DB_TEXT, suggestedFix: "Check DATABASE_URL" });
    setup();
    await toReview();
    await importAndFail();
    expect(screen.getByTestId("import-failure-text").textContent).toBe(GENERIC_ACTION_ERROR);
    expect(document.body.textContent).not.toMatch(/prisma|database server|localhost|DATABASE_URL/);
  });

  it("when the action throws (the connection failed) it does NOT claim that nothing was created: the outcome is unknown", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    h.importAction.mockRejectedValueOnce(new Error(RAW_DB_TEXT));
    const { onImported } = setup();
    await toReview();
    await importAndFail();
    expect(screen.getByTestId("import-failure-text").textContent).toBe(GENERIC_ACTION_ERROR);
    expect(screen.getByTestId("import-outcome-unknown").textContent).toMatch(/not known whether the import went through/);
    expect(screen.queryByTestId("import-nothing-created")).toBeNull();
    expect(document.body.textContent).not.toMatch(/prisma|database server/);
    expect(onImported).not.toHaveBeenCalled();
    expect(backButton().disabled).toBe(false);
    consoleError.mockRestore();
  });

  describe("a failure whose outcome is unknown (the action rejected)", () => {
    let consoleError: { mockRestore: () => void };
    beforeEach(() => {
      consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      h.importAction.mockRejectedValueOnce(new Error(RAW_DB_TEXT));
    });
    afterEach(() => consoleError.mockRestore());

    it("tells the user to close the window and look in the explorer, and refreshes the explorer so the event is there if it landed", async () => {
      setup();
      await toReview();
      expect(h.invalidate).not.toHaveBeenCalled();
      await importAndFail();
      expect(h.invalidate).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("import-outcome-unknown").textContent).toBe(OUTCOME_UNKNOWN);
      expect(OUTCOME_UNKNOWN).toMatch(/Close this window and look for the event in the explorer on the left before you import again\.$/);
    });

    it("offers no Try again (a second import could create the event twice), and no submit button at all", async () => {
      setup();
      await toReview();
      await importAndFail();
      expect(screen.queryByTestId("import-submit")).toBeNull();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      fireEvent.submit(form());
      expect(h.importAction).toHaveBeenCalledTimes(1);
    });

    it("offers Close, which closes the dialog", async () => {
      const { onOpenChange } = setup();
      await toReview();
      await importAndFail();
      const close = screen.getByTestId("import-close");
      expect(close.textContent).toBe("Close");
      expect((close as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(close);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("Back returns to the document (not the review), and a new Preview shows the taken name already numbered if the first import landed", async () => {
      setup();
      await toReview();
      await importAndFail();
      fireEvent.click(backButton());
      expect(stepText()).toBe("Step 1 of 3: Document");
      expect(documentBox().value).toBe(DOC);
      expect(screen.queryByTestId("import-failure")).toBeNull();
      h.preview.mockResolvedValueOnce({ success: true, data: { ...PREVIEW, eventName: "Streetlights-Kafka-API2" } });
      fireEvent.click(previewButton());
      await screen.findByTestId("import-step-review");
      expect(nameInput().value).toBe("Streetlights-Kafka-API2");
      expect(importButton().textContent).toBe("Import");
    });
  });

  describe("a definite failure", () => {
    it("with entities that could not be rolled back refreshes the explorer, so the user can find and delete them", async () => {
      h.importAction.mockResolvedValue({
        success: false, code: "IMPORT_FAILED", error: "The import failed.",
        details: { leftovers: [{ kind: "entity", id: "e1", name: "TurnOnOff2", code: "IN_USE", message: "in use" }] },
      });
      setup();
      await toReview();
      expect(h.invalidate).not.toHaveBeenCalled();
      await importAndFail();
      expect(h.invalidate).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("import-leftovers")).toBeDefined();
    });

    it("with nothing left over does not touch the explorer, and still offers Try again (and no Close in the footer)", async () => {
      h.importAction.mockResolvedValue({ success: false, code: "NAME_CONFLICT", error: "taken" });
      setup();
      await toReview();
      await importAndFail();
      expect(h.invalidate).not.toHaveBeenCalled();
      expect(importButton().textContent).toBe("Try again");
      expect(screen.queryByTestId("import-close")).toBeNull();
    });
  });

  it("a failed import that comes back with a problem list shows it", async () => {
    h.importAction.mockResolvedValue({
      success: false, code: "VALIDATION_ERROR", error: "The import failed.", details: { problems: [{ pointer: "/channels/a", message: "bad channel" }] },
    });
    setup();
    await toReview();
    await importAndFail();
    expect(screen.getByTestId("import-failure-headline").textContent).toBe("The document cannot be imported");
    expect(screen.getByTestId("import-problem-0").textContent).toContain("bad channel");
  });
});

describe("ImportAsyncApiDialog: a success whose navigation hangs", () => {
  // `shouldAdvanceTime`: Testing Library's own timers (findBy…, waitFor) keep running; the 15 s are advanced by hand.
  beforeEach(() => void vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => void vi.useRealTimers());

  async function imported() {
    const hosts = setup();
    await toReview();
    fireEvent.click(importButton());
    await waitFor(() => expect(hosts.onImported).toHaveBeenCalledWith("ev1"));
    // the success is on screen and its effects (the 15 s timer starts in one) have run: only then is the clock advanced
    await waitFor(() => expect(screen.getByTestId("import-progress").getAttribute("data-state")).toBe("imported"));
    await act(async () => {});
    return hosts;
  }
  const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

  it("stays locked for 15 s, then unlocks and says the event was created, with a Close button", async () => {
    const { onOpenChange } = await imported();
    await advance(IMPORT_STALL_MS - 1_000);
    expect(screen.getByTestId("import-progress-status").textContent).toContain("Opening the event");
    expect(screen.queryByTestId("import-stalled-close")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull(); // the dialog's X is still hidden: locked
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();

    await advance(1_500);
    expect(screen.getByTestId("import-progress-status").textContent).toBe(
      "This is taking longer than expected. The event was created; you can close this window and find it in the explorer on the left.",
    );
    const close = screen.getByTestId("import-stalled-close");
    expect(close.textContent).toBe("Close");
    // nothing offers the import again
    expect(screen.queryByTestId("import-submit")).toBeNull();
    fireEvent.submit(form());
    expect(h.importAction).toHaveBeenCalledTimes(1);

    // unlocked: Escape and Close both dismiss it
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();
    fireEvent.click(close);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  describe("the timer, in the hook", () => {
    const mount = () => {
      const onLockChange = vi.fn();
      const view = renderHook(() => useAsyncApiImport({ productId: "p1", onImported: vi.fn(), onLockChange }));
      return { ...view, onLockChange };
    };
    async function toImported(view: ReturnType<typeof mount>) {
      act(() => view.result.current.editContent(DOC));
      act(() => view.result.current.submit());
      await waitFor(() => expect(view.result.current.stage).toBe("preview"));
      act(() => view.result.current.submit());
      await waitFor(() => expect(view.result.current.stage).toBe("imported"));
      await act(async () => {}); // the effects of that render have run: the timer is set
    }

    it("fires once, 15 s after the success: unlocked and stalled", async () => {
      const view = mount();
      await toImported(view);
      expect(view.result.current.stalled).toBe(false);
      view.onLockChange.mockClear();
      await advance(IMPORT_STALL_MS);
      expect(view.result.current.stalled).toBe(true);
      expect(view.onLockChange).toHaveBeenCalledTimes(1);
      expect(view.onLockChange).toHaveBeenCalledWith(false);
    });

    it("is cleared when the dialog goes away first: nothing runs after the unmount", async () => {
      const view = mount();
      await toImported(view);
      view.unmount();
      view.onLockChange.mockClear();
      await advance(IMPORT_STALL_MS * 2);
      expect(view.onLockChange).not.toHaveBeenCalled();
    });

    it("is never started by a failure or by a preview", async () => {
      h.importAction.mockResolvedValue({ success: false, code: "NAME_CONFLICT", error: "taken" });
      const view = mount();
      act(() => view.result.current.editContent(DOC));
      act(() => view.result.current.submit());
      await waitFor(() => expect(view.result.current.stage).toBe("preview"));
      act(() => view.result.current.submit());
      await waitFor(() => expect(view.result.current.stage).toBe("failed"));
      view.onLockChange.mockClear();
      await advance(IMPORT_STALL_MS * 2);
      expect(view.result.current.stalled).toBe(false);
      expect(view.onLockChange).not.toHaveBeenCalled();
    });
  });
});

describe("ImportAsyncApiDialog: text that comes from the document never widens the dialog", () => {
  it("wraps a 300-character title and a 500-character warning pointer in the review", async () => {
    const title = "T".repeat(300);
    const pointer = `/components/messages/${"a".repeat(479)}`;
    expect(pointer).toHaveLength(500);
    h.preview.mockResolvedValue({ success: true, data: { ...PREVIEW, title, warnings: [{ pointer, code: "NO_PAYLOAD", message: "m".repeat(400) }] } });
    setup();
    await toReview();
    const heading = screen.getByTestId("import-title");
    expect(heading.textContent).toBe(`From the document “${title}”`);
    expect(heading.className).toContain("break-words");
    fireEvent.click(screen.getByTestId("import-warning-group-NO_PAYLOAD-toggle"));
    const item = screen.getByTestId("import-warning-group-NO_PAYLOAD-item");
    for (const text of [pointer, "m".repeat(400)]) {
      expect(within(item).getByText(text).className).toContain("break-words");
    }
  });

  it("wraps a 500-character pointer in the list of problems", async () => {
    const pointer = `/channels/${"c".repeat(490)}`;
    h.preview.mockResolvedValue({
      success: false, code: "VALIDATION_ERROR", error: "not valid", details: { problems: [{ pointer, message: "bad", code: "asyncapi-x" }] },
    });
    setup();
    type(documentBox(), DOC);
    fireEvent.click(previewButton());
    await screen.findByTestId("import-problems-panel");
    expect(within(screen.getByTestId("import-problem-0")).getByText(pointer).className).toContain("break-words");
  });
});

describe("ImportAsyncApiDialog: starting empty", () => {
  it("each opening starts on an empty document step, without the previous text, review or error", async () => {
    const onOpenChange = vi.fn();
    const ui = (open: boolean) => <ImportAsyncApiDialog productId="p1" open={open} onOpenChange={onOpenChange} onImported={vi.fn()} />;
    const view = render(ui(true));
    await toReview();
    view.rerender(ui(false));
    await waitFor(() => expect(screen.queryByTestId("import-form")).toBeNull());
    view.rerender(ui(true));
    expect(documentBox().value).toBe("");
    expect(stepText()).toBe("Step 1 of 3: Document");
    expect(screen.queryByTestId("import-error")).toBeNull();
  });
});

describe("NewEventDialog: Import existing…", () => {
  function Host() {
    const [open, setOpen] = useState(true);
    return <NewEventDialog productId="p1" open={open} onOpenChange={setOpen} onCreated={(id) => void h.order.push(`created:${id}`)} />;
  }

  it("is a link under the form that swaps the New Event dialog for the import dialog", async () => {
    render(<Host />);
    const link = screen.getByTestId("new-event-import-existing") as HTMLButtonElement;
    expect(link.textContent).toBe("Import existing…");
    expect(link.type).toBe("button");
    expect(screen.queryByTestId("import-asyncapi-dialog")).toBeNull();
    fireEvent.click(link);
    expect(await screen.findByTestId("import-asyncapi-dialog")).toBeDefined();
    await waitFor(() => expect(screen.queryByTestId("new-event-dialog")).toBeNull());
    expect(h.createEventAction).not.toHaveBeenCalled();
    expect(documentBox().value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(documentBox()));
  });

  it("an imported event is reported through onCreated, like a created one (the callers navigate to it)", async () => {
    render(<Host />);
    fireEvent.click(screen.getByTestId("new-event-import-existing"));
    await screen.findByTestId("import-asyncapi-dialog");
    await toReview();
    fireEvent.click(importButton());
    await waitFor(() => expect(h.order).toContain("created:ev1"));
    expect(h.order).toEqual(["toast", "invalidate", "created:ev1"]);
    expect(h.importAction).toHaveBeenCalledWith("p1", { content: DOC, eventName: "Streetlights-Kafka-API" });
  });

  it("cancelling the import closes it and does not reopen New Event", async () => {
    render(<Host />);
    fireEvent.click(screen.getByTestId("new-event-import-existing"));
    await screen.findByTestId("import-asyncapi-dialog");
    fireEvent.click(cancelButton());
    await waitFor(() => expect(screen.queryByTestId("import-asyncapi-dialog")).toBeNull());
    expect(screen.queryByTestId("new-event-dialog")).toBeNull();
  });

  it("is off while an event is being created", async () => {
    h.createEventAction.mockReturnValue(new Promise(() => {}));
    render(<Host />);
    fireEvent.change(screen.getByTestId("new-event-name"), { target: { value: "orders" } });
    fireEvent.click(screen.getByTestId("new-event-submit"));
    await waitFor(() => expect((screen.getByTestId("new-event-import-existing") as HTMLButtonElement).disabled).toBe(true));
  });
});
