/**
 * The e2e helper that reads the generated artifact off the Schemas tab. A version of several files (one per entity, an inline enum
 * of JSON Schema in a file of its own) shows ONE file at a time, so the helper walks the file list and joins every file in the
 * `===== path =====` bundle form (`SchemaVersion.output`); a single plain preview is returned as it is. The page driving itself is
 * not run here (no browser): this pins the walking and joining against a fake of the page.
 */
import { describe, expect, it } from "vitest";
import { bundlePreviewFiles, readPreviewFrom, type PreviewSource } from "../../e2e/helpers/preview-text";

/** A page showing `files` one at a time (or one plain preview when `files` is empty and `plain` is given). */
function fakePage(files: Array<{ path: string; content: string }>, plain = "") {
  let selected = 0;
  const log: string[] = [];
  const source: PreviewSource = {
    filePaths: async () => files.map((f) => f.path),
    select: async (index) => {
      log.push(`select ${index}`);
      selected = index;
    },
    code: async () => (files.length === 0 ? plain : files[selected].content),
  };
  return { source, log, selected: () => selected };
}

describe("bundlePreviewFiles", () => {
  it("is the ===== path ===== form of the stored output, files separated by a blank line, trailing whitespace trimmed", () => {
    expect(
      bundlePreviewFiles([
        { path: "a/Customer.json", content: '{ "a": 1 }\n' },
        { path: "a/Address.json", content: '{ "b": 2 }' },
      ]),
    ).toBe('===== a/Customer.json =====\n{ "a": 1 }\n\n===== a/Address.json =====\n{ "b": 2 }');
  });
});

describe("readPreviewFrom", () => {
  it("returns the single plain preview as it is when the version has no file list", async () => {
    const { source, log } = fakePage([], "CREATE TABLE t (id INT64);");

    expect(await readPreviewFrom(source)).toBe("CREATE TABLE t (id INT64);");
    expect(log).toEqual([]);
  });

  it("shows every file of a multi-file version: an inline enum's own file is part of what is read", async () => {
    const { source } = fakePage([
      { path: "Address.json", content: '{ "properties": { "kind": { "$ref": "Address_kind.json" } } }' },
      { path: "Address_kind.json", content: '{ "enum": ["in_progress", "done"] }' },
    ]);

    const text = await readPreviewFrom(source);

    expect(text).toContain("===== Address.json =====");
    expect(text).toContain("===== Address_kind.json =====");
    expect(text).toContain("in_progress");
    expect(text).toContain("done");
  });

  it("walks the list in order, then selects the first file again so the page is left as it was found", async () => {
    const { source, log, selected } = fakePage([
      { path: "a.json", content: "A" },
      { path: "b.json", content: "B" },
      { path: "c.json", content: "C" },
    ]);

    await readPreviewFrom(source);

    expect(log).toEqual(["select 0", "select 1", "select 2", "select 0"]);
    expect(selected()).toBe(0);
  });

  it("changes when only a NON-root file changes (the change detection of a regeneration compares this text)", async () => {
    const root = { path: "a.json", content: "root" };
    const before = await readPreviewFrom(fakePage([root, { path: "b.json", content: "old" }]).source);
    const after = await readPreviewFrom(fakePage([root, { path: "b.json", content: "new" }]).source);

    expect(after).not.toBe(before);
  });
});
