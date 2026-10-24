/**
 * The e2e helper that reads the generated artifact off the Schemas tab. A version of several files (one per entity, an inline enum of
 * JSON Schema in a file of its own) shows ONE file at a time, so the helper walks the file list and joins every file in the
 * `===== path =====` bundle form (`SchemaVersion.output`); a single plain preview is returned as it is. The page driving itself is
 * not run here (no browser): this pins the walking, joining, splitting and settling against a fake of the page.
 */
import { describe, expect, it } from "vitest";
import {
  bundlePreviewFiles,
  previewSignature,
  readPreviewFrom,
  settlePreview,
  splitBundle,
  type PreviewSource,
} from "../../e2e/helpers/preview-text";

type FileSpec = { path: string; content: string };

/** A page showing `files` one at a time (or one plain preview when `files` is empty and `plain` is given). */
function fakePage(files: FileSpec[], plain = "") {
  let selected = 0;
  const log: string[] = [];
  const source: PreviewSource = {
    filePaths: async () => files.map((f) => f.path),
    select: async (path) => {
      const index = files.findIndex((f) => f.path === path);
      if (index === -1) throw new Error(`no file ${path}`);
      log.push(`select ${path}`);
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

describe("splitBundle", () => {
  it("is the inverse of the bundle form: path and content of each file, in order", () => {
    const files = [
      { path: "Ticket.json", content: '{\n  "title": "Ticket",\n  "required": ["ticket_id"]\n}' },
      { path: "Ticket_state.json", content: '{\n  "enum": ["new", "in_progress", "done"]\n}' },
    ];
    expect(splitBundle(bundlePreviewFiles(files))).toEqual(files);
  });

  it("a text without a header is ONE file with no path, as it is (a single plain preview, JSON or YAML)", () => {
    expect(splitBundle('{ "title": "T" }')).toEqual([{ path: "", content: '{ "title": "T" }' }]);
    expect(splitBundle("openapi: 3.1.0\ninfo:\n  title: T\n")).toEqual([{ path: "", content: "openapi: 3.1.0\ninfo:\n  title: T\n" }]);
    expect(splitBundle("")).toEqual([{ path: "", content: "" }]);
  });

  it("keeps blank lines inside a file and drops only the separator after it", () => {
    const text = "===== a.yaml =====\nx: 1\n\ny: 2\n\n===== b.yaml =====\nz: 3";
    expect(splitBundle(text)).toEqual([
      { path: "a.yaml", content: "x: 1\n\ny: 2" },
      { path: "b.yaml", content: "z: 3" },
    ]);
  });

  it("keeps text before the first header as a file of its own, and ignores a blank lead", () => {
    expect(splitBundle("preamble\n===== a.json =====\n{}")).toEqual([
      { path: "", content: "preamble" },
      { path: "a.json", content: "{}" },
    ]);
    expect(splitBundle("\n\n===== a.json =====\n{}")).toEqual([{ path: "a.json", content: "{}" }]);
  });

  it("a line that only looks like a header inside a file's content (extra text on the line) is content", () => {
    const text = "===== a.txt =====\nsee ===== b =====\nmore";
    expect(splitBundle(text)).toEqual([{ path: "a.txt", content: "see ===== b =====\nmore" }]);
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

  it("walks the list in order by path, then selects the first file again so the page is left as it was found", async () => {
    const { source, log, selected } = fakePage([
      { path: "a.json", content: "A" },
      { path: "b.json", content: "B" },
      { path: "c.json", content: "C" },
    ]);

    await readPreviewFrom(source);

    expect(log).toEqual(["select a.json", "select b.json", "select c.json", "select a.json"]);
    expect(selected()).toBe(0);
  });

  it("changes when only a NON-root file changes (the change detection of a regeneration compares this text)", async () => {
    const root = { path: "a.json", content: "root" };
    const before = await readPreviewFrom(fakePage([root, { path: "b.json", content: "old" }]).source);
    const after = await readPreviewFrom(fakePage([root, { path: "b.json", content: "new" }]).source);

    expect(after).not.toBe(before);
  });

  it("clicks the file it listed, by its path: a list that changed order mid-walk cannot mix files up", async () => {
    // the list is re-rendered in the opposite order after the first click: an index would now point at the other file
    let order = ["a.json", "b.json"];
    const content: Record<string, string> = { "a.json": "A", "b.json": "B" };
    let shown = "a.json";
    const source: PreviewSource = {
      filePaths: async () => [...order],
      select: async (path) => {
        shown = path;
        order = ["b.json", "a.json"];
      },
      code: async () => content[shown],
    };

    await expect(readPreviewFrom(source)).rejects.toThrow(/file list changed/);
  });

  it("reads the right file for each path even when it is listed the same way throughout", async () => {
    const { source } = fakePage([
      { path: "b.json", content: "B" },
      { path: "a.json", content: "A" },
    ]);
    expect(splitBundle(await readPreviewFrom(source))).toEqual([
      { path: "b.json", content: "B" },
      { path: "a.json", content: "A" },
    ]);
  });

  it("throws, not returns a mixture, when a listed file is gone by the time it is selected", async () => {
    const files = [
      { path: "a.json", content: "A" },
      { path: "b.json", content: "B" },
    ];
    const { source } = fakePage(files);
    const flaky: PreviewSource = { ...source, select: async (path) => (path === "b.json" ? Promise.reject(new Error("no such file")) : source.select(path)) };

    await expect(readPreviewFrom(flaky)).rejects.toThrow("no such file");
  });
});

describe("previewSignature", () => {
  it("is the list of paths and the file on show: it does not click through the files", async () => {
    const { source, log } = fakePage([
      { path: "a.json", content: "A" },
      { path: "b.json", content: "B" },
    ]);

    expect(await previewSignature(source)).toBe("a.json\nb.json\n--\nA");
    expect(log).toEqual([]);
  });
});

describe("settlePreview", () => {
  /** A page whose signature / full reads are counted; `walks` reads every file (one click each). */
  function counting(read: () => string, signature: () => string) {
    const calls = { read: 0, signature: 0, waited: 0 };
    return {
      calls,
      read: async () => {
        calls.read += 1;
        return read();
      },
      signature: async () => {
        calls.signature += 1;
        return signature();
      },
      wait: async (ms: number) => {
        calls.waited += ms;
      },
    };
  }

  it("a regeneration that yields UNCHANGED output costs one cheap signature per round and a full read only every fifth round, within the same 8 s", async () => {
    const page = counting(() => "same", () => "sig");

    const text = await settlePreview({ previous: "same", previousSignature: "sig", ...page });

    expect(text).toBe("same");
    expect(page.calls.waited).toBe(40 * 200); // the same budget as before: 8 s
    expect(page.calls.signature).toBe(40);
    // 1 immediate + one every fifth of 40 rounds = 9 full reads, not 41
    expect(page.calls.read).toBe(1 + 8);
  });

  it("stops at once, with one full read, when the signature changes", async () => {
    let regenerated = false;
    const page = counting(() => (regenerated ? "new" : "old"), () => (regenerated ? "sig2" : "sig1"));
    const waited = page.wait;
    page.wait = async (ms) => {
      await waited(ms);
      if (page.calls.waited >= 400) regenerated = true; // the versions reload during the second round
    };

    const text = await settlePreview({ previous: "old", previousSignature: "sig1", ...page });

    expect(text).toBe("new");
    expect(page.calls.waited).toBe(400);
    expect(page.calls.read).toBe(2); // the immediate one and the one the changed signature asked for
  });

  it("sees a change in a file that is NOT on show within a fifth-round walk, while the signature stays the same", async () => {
    let regenerated = false;
    const page = counting(() => (regenerated ? "root+new" : "root+old"), () => "sig");
    const waited = page.wait;
    page.wait = async (ms) => {
      await waited(ms);
      if (page.calls.waited >= 200) regenerated = true;
    };

    const text = await settlePreview({ previous: "root+old", previousSignature: "sig", ...page });

    expect(text).toBe("root+new");
    expect(page.calls.waited).toBe(5 * 200); // seen at the first scheduled walk (round 5), not after the whole 8 s
  });

  it("a read that throws (the list was replaced under it) counts as not settled and is tried again", async () => {
    let attempts = 0;
    const page = counting(() => {
      attempts += 1;
      if (attempts < 3) throw new Error("the file list changed while the artifact was read");
      return "settled";
    }, () => "sig");

    expect(await settlePreview({ previous: "old", previousSignature: "sig", ...page })).toBe("settled");
  });

  it("returns what was last read when the budget is spent", async () => {
    const page = counting(() => "", () => "sig");
    expect(await settlePreview({ previous: "x", previousSignature: "sig", rounds: 3, ...page })).toBe("");
    expect(page.calls.waited).toBe(600);
  });
});
