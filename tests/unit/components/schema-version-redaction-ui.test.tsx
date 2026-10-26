/**
 * KD-046 on the Schemas tab: a version the server redacted for the reader (the files of entities their roles do not cover were taken out) says so, shows
 * only the files that were left, downloads only those in the zip ("Download all"), and a version with nothing left says that instead of an empty editor.
 * The redacted copy is made by the real `redactSchemaVersionsMap`, from a stored version that carries a file of an entity the reader may not read.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SchemaVersionOutput } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/SchemaVersionOutput";
import { redactSchemaVersionsMap } from "@/lib/access/schema-version-redaction";
import { readZipEntries } from "@/lib/zip-store";
import { bundleFileContents } from "@/lib/typespec-official/bundle";
import type { SchemaVersion } from "@/types/schema-version";

const ROOT = "e-root";
const FILES = [
  { path: "Sales/Order.json", content: '{ "title": "Order-body" }', target: "json-schema", entityId: ROOT },
  { path: "Sales/Line.json", content: '{ "title": "Line-body" }', target: "json-schema", entityId: "e-line" },
  { path: "Finance/Ledger.json", content: '{ "title": "Ledger-body", "iban": {} }', target: "json-schema", entityId: "e-ledger" },
];
const stored: SchemaVersion = {
  version: 1,
  status: "draft",
  output: bundleFileContents(FILES),
  generatedAt: "2026-01-01T00:00:00.000Z",
  entityVersion: 1,
  files: FILES as SchemaVersion["files"],
  resolution: {
    mode: "published",
    preview: false,
    entities: FILES.map((f) => ({ ref: { entityId: f.entityId, domain: f.path.split("/")[0], product: "P", entity: f.path.split("/")[1].replace(".json", "") }, source: "published" as const, version: "1.0" })),
  },
};
const forReader = (mayRead: (id: string) => boolean) => redactSchemaVersionsMap({ "json-schema": [stored] }, { rootEntityId: ROOT, mayRead })["json-schema"][0];

const onCopy = vi.fn();
const show = (version: SchemaVersion) => render(<SchemaVersionOutput version={version} entityId={ROOT} entityName="Order" language="json" onCopy={onCopy} />);
const paths = () => screen.getAllByTestId("schema-file-item").map((el) => el.getAttribute("data-path"));

let blobs: Blob[];
beforeEach(() => {
  blobs = [];
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn((blob: Blob) => (blobs.push(blob), `blob:${blobs.length}`)), configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const bytesOf = (blob: Blob) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });

describe("a version redacted for the reader", () => {
  it("says how many files are hidden, lists only the files that are left, and shows nothing of the hidden ones", () => {
    show(forReader((id) => id === "e-line"));
    const note = screen.getByTestId("schema-version-redacted");
    expect(note.textContent).toBe("1 file of referenced entities is hidden for your role");
    expect(note.getAttribute("role")).toBe("note");
    expect(paths()).toEqual(["Sales/Order.json", "Sales/Line.json"]);
    expect(document.body.textContent).not.toContain("Ledger");
    expect(document.body.textContent).not.toContain("iban");
  });

  it("the zip of 'Download all' holds the permitted files only", async () => {
    show(forReader((id) => id === "e-line"));
    fireEvent.click(screen.getByTestId("schema-file-set-download-all"));
    await waitFor(() => expect(blobs).toHaveLength(1));
    const entries = readZipEntries(await bytesOf(blobs[0]));
    expect(entries.map((e) => e.path)).toEqual(["Sales/Order.json", "Sales/Line.json"]);
    expect(entries.map((e) => new TextDecoder().decode(e.content)).join("")).not.toContain("iban");
  });

  it("the root only: the one file is shown as a plain preview, with the note, and the count is plural for two hidden files", () => {
    show(forReader(() => false));
    expect(screen.getByTestId("schema-version-redacted").textContent).toBe("2 files of referenced entities are hidden for your role");
    expect(screen.queryByTestId("schema-file-set-list")).toBeNull();
    expect(screen.getByTestId("schema-code-preview").textContent).toContain("Order-body");
  });

  it("a version with nothing left to show says so instead of showing an empty editor", () => {
    const noFiles = redactSchemaVersionsMap(
      { openapi3: [{ ...stored, files: FILES.map((f) => ({ ...f, target: "openapi3" })) as SchemaVersion["files"] }] },
      { rootEntityId: ROOT, mayRead: () => false }
    ).openapi3[0];
    show(noFiles);
    expect(screen.getByTestId("schema-version-redacted").textContent).toContain("3 files");
    expect(screen.getByTestId("schema-version-nothing-to-show").textContent).toBe("Nothing of this version can be shown for your role.");
    expect(screen.queryByTestId("schema-code-preview")).toBeNull();
  });
});

describe("a version shown whole", () => {
  it("has no note, lists every file and puts every file in the zip", async () => {
    show(forReader(() => true));
    expect(screen.queryByTestId("schema-version-redacted")).toBeNull();
    expect(paths()).toEqual(["Sales/Order.json", "Sales/Line.json", "Finance/Ledger.json"]);
    fireEvent.click(screen.getByTestId("schema-file-set-download-all"));
    await waitFor(() => expect(blobs).toHaveLength(1));
    expect(readZipEntries(await bytesOf(blobs[0])).map((e) => e.path)).toEqual(["Sales/Order.json", "Sales/Line.json", "Finance/Ledger.json"]);
  });
});
