/**
 * The files of a generated schema version (multi-entity emission): the list, the selected file in the code preview, copy per file,
 * "Download all". A closure's files are grouped by entity where the entity is known; the view never assumes every entity has a file.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SchemaFileSet } from "@/components/custom/SchemaFileSet/SchemaFileSet";
import type { EmittedFile } from "@/lib/typespec-official/closure-emit";
import type { SchemaVersionResolution } from "@/types/schema-version";

const FILES: EmittedFile[] = [
  { path: "Sales/Crm/Customer.json", content: '{ "title": "Customer-body" }', target: "json-schema", entityId: "e-customer" },
  { path: "Sales/Crm/Address.json", content: '{ "title": "Address-body" }', target: "json-schema", entityId: "e-address" },
];

const ENTITIES: SchemaVersionResolution["entities"] = [
  { ref: { entityId: "e-customer", domain: "Sales", product: "Crm", entity: "Customer" }, source: "draft" },
  { ref: { entityId: "e-address", domain: "Billing", product: "Core", entity: "Address" }, source: "published", version: "1.0" },
];

const writeText = vi.fn();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(cleanup);

const previewText = () => screen.getByTestId("schema-code-preview").textContent ?? "";
const itemPaths = () => screen.getAllByTestId("schema-file-item").map((el) => el.getAttribute("data-path"));

describe("SchemaFileSet", () => {
  it("lists every file and shows the first one in the code preview", () => {
    render(<SchemaFileSet files={FILES} entityName="Customer" />);

    expect(screen.getByTestId("schema-file-set-list")).toBeDefined();
    expect(itemPaths()).toEqual(["Sales/Crm/Customer.json", "Sales/Crm/Address.json"]);
    expect(previewText()).toContain("Customer-body");
    expect(previewText()).not.toContain("Address-body");
  });

  it("switches the code shown when another file is picked", () => {
    render(<SchemaFileSet files={FILES} entityName="Customer" />);

    fireEvent.click(screen.getAllByTestId("schema-file-item")[1]);

    expect(previewText()).toContain("Address-body");
    expect(previewText()).not.toContain("Customer-body");
    expect(screen.getAllByTestId("schema-file-item")[1].getAttribute("aria-current")).toBe("true");
    expect(screen.getAllByTestId("schema-file-item")[0].getAttribute("aria-current")).toBeNull();
  });

  it("labels the code preview with the selected file's path", () => {
    render(<SchemaFileSet files={FILES} entityName="Customer" />);
    expect(within(screen.getByTestId("schema-code-preview")).getByText("Sales/Crm/Customer.json")).toBeDefined();
  });

  it("copies the selected file, not the set", async () => {
    const onCopy = vi.fn();
    render(<SchemaFileSet files={FILES} entityName="Customer" onCopy={onCopy} />);

    fireEvent.click(screen.getAllByTestId("schema-file-item")[1]);
    fireEvent.click(screen.getByTestId("schema-code-copy"));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(FILES[1].content);
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it("groups the files by entity as domain / product / entity, the root's first, from the resolution", () => {
    render(<SchemaFileSet files={[...FILES].reverse()} entityName="Customer" entities={ENTITIES} />);

    const groups = screen.getAllByTestId("schema-file-group");
    expect(groups.map((g) => within(g).getByTestId("schema-file-group-title").textContent)).toEqual([
      "Sales / Crm / Customer",
      "Billing / Core / Address",
    ]);
    expect(within(groups[0]).getAllByTestId("schema-file-item").map((el) => el.getAttribute("data-path"))).toEqual(["Sales/Crm/Customer.json"]);
    // the root's file is the one shown first
    expect(previewText()).toContain("Customer-body");
  });

  it("keeps a file whose entity is not known in an 'Other files' group", () => {
    const files: EmittedFile[] = [...FILES, { path: "common.json", content: "{}", target: "json-schema" }];
    render(<SchemaFileSet files={files} entityName="Customer" entities={ENTITIES} />);

    const titles = screen.getAllByTestId("schema-file-group-title").map((el) => el.textContent);
    expect(titles).toEqual(["Sales / Crm / Customer", "Billing / Core / Address", "Other files"]);
  });

  it("does not assume every entity has a file: a Protobuf cycle's second member is named as sharing the file", () => {
    const cycle: EmittedFile[] = [{ path: "Sales/Crm/Customer.proto", content: "syntax = \"proto3\";", target: "protobuf", entityId: "e-customer" }];
    render(<SchemaFileSet files={cycle} entityName="Customer" entities={ENTITIES} />);

    expect(screen.queryByTestId("schema-file-set-list")).toBeNull();
    expect(previewText()).toContain("proto3");
    const note = screen.getByTestId("schema-file-set-shared-note");
    expect(note.textContent).toContain("Billing / Core / Address");
    expect(note.textContent).not.toContain("Sales / Crm / Customer");
  });

  it("lists the files that exist when a cycle shares one file among several entities", () => {
    const files: EmittedFile[] = [
      { path: "Sales/Crm/Customer.proto", content: "// customer + address", target: "protobuf", entityId: "e-customer" },
      { path: "Core/Money.proto", content: "// money", target: "protobuf", entityId: "e-money" },
    ];
    const entities: SchemaVersionResolution["entities"] = [
      ...ENTITIES,
      { ref: { entityId: "e-money", domain: "Billing", product: "Core", entity: "Money" }, source: "published", version: "2.0" },
    ];
    render(<SchemaFileSet files={files} entityName="Customer" entities={entities} />);

    expect(itemPaths()).toEqual(["Sales/Crm/Customer.proto", "Core/Money.proto"]);
    expect(screen.getByTestId("schema-file-set-shared-note").textContent).toContain("Billing / Core / Address");
  });

  it("shows no group titles and no shared-file note without a resolution", () => {
    render(<SchemaFileSet files={FILES} entityName="Customer" />);
    expect(screen.queryAllByTestId("schema-file-group-title")).toHaveLength(0);
    expect(screen.queryByTestId("schema-file-set-shared-note")).toBeNull();
  });

  it("renders a single file as a plain code preview, without a list", () => {
    render(<SchemaFileSet files={[FILES[0]]} entityName="Customer" />);

    expect(screen.queryByTestId("schema-file-set-list")).toBeNull();
    expect(previewText()).toContain("Customer-body");
  });

  it("falls back to the first file when the selected path is no longer in the set", () => {
    const { rerender } = render(<SchemaFileSet files={FILES} entityName="Customer" />);
    fireEvent.click(screen.getAllByTestId("schema-file-item")[1]);
    expect(previewText()).toContain("Address-body");

    rerender(<SchemaFileSet files={[{ path: "Other/Thing.json", content: '{ "title": "Thing-body" }', target: "json-schema", entityId: "e-thing" }, FILES[0]]} entityName="Customer" />);

    expect(previewText()).toContain("Thing-body");
  });

  it("highlights by the file's extension (JSON), plain text otherwise", () => {
    const files: EmittedFile[] = [
      { path: "a.json", content: '"k": 1', target: "json-schema", entityId: "x" },
      { path: "b.proto", content: 'message B {}', target: "protobuf", entityId: "y" },
    ];
    render(<SchemaFileSet files={files} entityName="A" />);
    // a highlighted JSON line splits the key and the number into separate spans; plain text is one span
    expect(screen.getByTestId("schema-code-preview").querySelectorAll("code span span").length).toBeGreaterThan(1);
    fireEvent.click(screen.getAllByTestId("schema-file-item")[1]);
    expect(previewText()).toContain("message B {}");
  });
});

describe("SchemaFileSet download all", () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clicked: Array<{ download: string; href: string }>;

  beforeEach(() => {
    clicked = [];
    createObjectURL = vi.fn((blob: Blob) => `blob:${blob.size}`);
    revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("downloads each file in turn, named after its path (no directory separators)", async () => {
    render(<SchemaFileSet files={FILES} entityName="Customer" />);

    fireEvent.click(screen.getByTestId("schema-file-set-download-all"));

    await waitFor(() => expect(clicked).toHaveLength(2));
    expect(clicked.map((c) => c.download)).toEqual(["Sales_Crm_Customer.json", "Sales_Crm_Address.json"]);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("keeps two files whose flattened names collide apart", async () => {
    const files: EmittedFile[] = [
      { path: "a/b_c.json", content: "1", target: "json-schema", entityId: "x" },
      { path: "a_b/c.json", content: "2", target: "json-schema", entityId: "y" },
    ];
    render(<SchemaFileSet files={files} entityName="A" />);

    fireEvent.click(screen.getByTestId("schema-file-set-download-all"));

    await waitFor(() => expect(clicked).toHaveLength(2));
    expect(new Set(clicked.map((c) => c.download)).size).toBe(2);
  });

  it("names the number of files on the button", () => {
    render(<SchemaFileSet files={FILES} entityName="Customer" />);
    expect(screen.getByTestId("schema-file-set-download-all").textContent).toContain("2 files");
  });
});
