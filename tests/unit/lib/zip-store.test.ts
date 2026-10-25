import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZip, crc32, readZipEntries, zipEntryNames } from "@/lib/zip-store";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("crc32", () => {
  it("matches the standard check value and the empty input", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("createZip / readZipEntries", () => {
  it("round-trips the paths (directories kept) and the contents, in order", () => {
    const zip = createZip([
      { path: "Sales/Crm/Customer.proto", content: 'import "Sales/Crm/Address.proto";\nmessage Customer {}\n' },
      { path: "Sales/Crm/Address.proto", content: "message Address {}\n" },
      { path: "readme.txt", content: "" },
    ]);
    const entries = readZipEntries(zip);
    expect(entries.map((e) => e.path)).toEqual(["Sales/Crm/Customer.proto", "Sales/Crm/Address.proto", "readme.txt"]);
    expect(text(entries[0].content)).toBe('import "Sales/Crm/Address.proto";\nmessage Customer {}\n');
    expect(text(entries[1].content)).toBe("message Address {}\n");
    expect(entries[2].content).toHaveLength(0);
  });

  it("stores non-ASCII names and contents as UTF-8", () => {
    const entries = readZipEntries(createZip([{ path: "顧客/住所.json", content: '{"名前":"Ünï"}' }]));
    expect(entries[0].path).toBe("顧客/住所.json");
    expect(text(entries[0].content)).toBe('{"名前":"Ünï"}');
  });

  it("carries binary content as it is", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(readZipEntries(createZip([{ path: "b.bin", content: bytes }]))[0].content).toEqual(bytes);
  });

  it("is deterministic: the same entries give the same bytes", () => {
    const entries = [{ path: "a.txt", content: "A" }, { path: "d/b.txt", content: "B" }];
    expect(createZip(entries)).toEqual(createZip(entries));
  });

  it("an empty zip is a valid empty zip", () => {
    expect(readZipEntries(createZip([]))).toEqual([]);
  });

  it("refuses bytes that are not a zip, a compressed entry, and a damaged CRC", () => {
    expect(() => readZipEntries(new TextEncoder().encode("hello, not a zip at all"))).toThrow(/Not a zip/);
    const zip = createZip([{ path: "a.txt", content: "payload" }]);
    const damaged = zip.slice();
    damaged[30 + "a.txt".length] ^= 0xff; // the first content byte
    expect(() => readZipEntries(damaged)).toThrow(/Bad CRC/);
    const deflated = zip.slice();
    // the central directory entry's method field (offset of the directory + 10)
    const view = new DataView(deflated.buffer);
    const centralAt = view.getUint32(deflated.length - 22 + 16, true);
    view.setUint16(centralAt + 10, 8, true);
    expect(() => readZipEntries(deflated)).toThrow(/compression method 8/);
  });
});

describe("zipEntryNames", () => {
  it("keeps directories and turns a backslash into a separator", () => {
    expect(zipEntryNames(["a/b/c.json", "a\\b\\d.json"])).toEqual(["a/b/c.json", "a/b/d.json"]);
  });

  it("never lets a name leave its folder: leading slashes, '.' and '..' segments go", () => {
    expect(zipEntryNames(["/etc/passwd", "../../evil.txt", "a/../../b.txt", "./c.txt", "a//d.txt"])).toEqual(["etc/passwd", "evil.txt", "a/b.txt", "c.txt", "a/d.txt"]);
  });

  it("replaces control characters and names an empty path 'file'", () => {
    expect(zipEntryNames(["a\u0000b\nc.txt", "", "///"])).toEqual(["a_b_c.txt", "file", "file-2"]);
  });

  it("keeps two paths that end up with one name apart (-2, -3 before the extension), case-insensitively", () => {
    expect(zipEntryNames(["a/x.json", "a//x.json", "A/X.json", "a/y"])).toEqual(["a/x.json", "a/x-2.json", "A/X-3.json", "a/y"]);
    expect(zipEntryNames(["y", "y"])).toEqual(["y", "y-2"]);
  });
});

// The real thing: an unzip tool reads what is written. Skipped where python3 is not installed.
const python = spawnSync("python3", ["-I", "-c", "import zipfile"]);
describe.skipIf(python.status !== 0)("python3's zipfile reads what createZip writes", () => {
  it("lists the same paths, passes the CRC test and reads the same contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "zip-store-"));
    try {
      const file = join(dir, "set.zip");
      writeFileSync(file, createZip([
        { path: "Sales/Crm/Customer.json", content: '{"title":"Customer"}' },
        { path: "顧客/住所.json", content: "住所" },
        { path: "empty.txt", content: "" },
      ]));
      const script = [
        "import sys, zipfile, json",
        "z = zipfile.ZipFile(sys.argv[1])",
        "print(json.dumps({'bad': z.testzip(), 'names': z.namelist(), 'first': z.read('Sales/Crm/Customer.json').decode('utf-8'), 'second': z.read('顧客/住所.json').decode('utf-8')}, ensure_ascii=False))",
      ].join("\n");
      const run = spawnSync("python3", ["-I", "-c", script, file], { encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        bad: null,
        names: ["Sales/Crm/Customer.json", "顧客/住所.json", "empty.txt"],
        first: '{"title":"Customer"}',
        second: "住所",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
