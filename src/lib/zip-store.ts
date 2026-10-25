/**
 * A STORE-only ZIP writer and a reader for what it writes (no compression, no dependency): CRC-32, one local header per entry, the
 * central directory and the end record. It is what "Download all" saves, so a file set keeps its directories (a Protobuf
 * `import "D/P/Record.proto"` and a Java package directory only work where their paths are kept), and it is plain enough that
 * every unzip tool reads it.
 *
 * Deterministic: the same entries give the same bytes (a fixed DOS timestamp). Names are UTF-8 (flag bit 11). Pure; runs in the
 * browser and in Node. Zip64 is not written: more than 65535 entries or 4 GiB is refused (a closure holds at most a few hundred files).
 */

export type ZipEntryInput = { path: string; content: string | Uint8Array };
export type ZipEntry = { path: string; content: Uint8Array };

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
/** UTF-8 file names. */
const FLAG_UTF8 = 0x0800;
/** 1980-01-01 00:00:00: the earliest DOS date, so the bytes do not depend on when the zip was made. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const VERSION = 20;
const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 (IEEE, the one zip uses) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * One safe, unique entry name per path, in order. Directories are kept (`/` separators); a backslash is a separator, a leading `/` and any
 * `.` / `..` / empty segment go (a name can never climb out of the folder an unzip tool extracts into), a control character becomes `_`,
 * and a name an earlier entry already took gets `-2`, `-3`, ... before its extension.
 */
export function zipEntryNames(paths: readonly string[]): string[] {
  const used = new Set<string>();
  return paths.map((path) => {
    const cleaned = String(path).replace(/[\u0000-\u001f\u007f]/g, "_");
    const segments = cleaned.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== "." && segment !== "..");
    const flat = segments.join("/") || "file";
    let name = flat;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) {
      const slash = flat.lastIndexOf("/");
      const dot = flat.lastIndexOf(".");
      name = dot > slash + 1 ? `${flat.slice(0, dot)}-${n}${flat.slice(dot)}` : `${flat}-${n}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

const encoder = new TextEncoder();

/** Builds a STORE zip of `entries` (see {@link zipEntryNames} for how names are made safe). */
export function createZip(entries: readonly ZipEntryInput[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) throw new RangeError(`A zip holds at most ${MAX_ENTRIES} files (got ${entries.length}).`);
  const names = zipEntryNames(entries.map((entry) => entry.path)).map((name) => encoder.encode(name));
  const data = entries.map((entry) => (typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content));

  let size = 22; // the end record
  for (let i = 0; i < entries.length; i++) size += 30 + names[i].length + data[i].length + 46 + names[i].length;
  if (size > MAX_SIZE) throw new RangeError("The zip would be larger than 4 GiB.");

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];
  const crcs: number[] = [];

  for (let i = 0; i < entries.length; i++) {
    const crc = crc32(data[i]);
    crcs.push(crc);
    offsets.push(at);
    view.setUint32(at, LOCAL_SIGNATURE, true);
    view.setUint16(at + 4, VERSION, true);
    view.setUint16(at + 6, FLAG_UTF8, true);
    view.setUint16(at + 8, 0, true); // method: stored
    view.setUint16(at + 10, DOS_TIME, true);
    view.setUint16(at + 12, DOS_DATE, true);
    view.setUint32(at + 14, crc, true);
    view.setUint32(at + 18, data[i].length, true);
    view.setUint32(at + 22, data[i].length, true);
    view.setUint16(at + 26, names[i].length, true);
    view.setUint16(at + 28, 0, true); // no extra field
    out.set(names[i], at + 30);
    out.set(data[i], at + 30 + names[i].length);
    at += 30 + names[i].length + data[i].length;
  }

  const centralStart = at;
  for (let i = 0; i < entries.length; i++) {
    view.setUint32(at, CENTRAL_SIGNATURE, true);
    view.setUint16(at + 4, VERSION, true); // made by
    view.setUint16(at + 6, VERSION, true); // needed
    view.setUint16(at + 8, FLAG_UTF8, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, DOS_TIME, true);
    view.setUint16(at + 14, DOS_DATE, true);
    view.setUint32(at + 16, crcs[i], true);
    view.setUint32(at + 20, data[i].length, true);
    view.setUint32(at + 24, data[i].length, true);
    view.setUint16(at + 28, names[i].length, true);
    view.setUint16(at + 30, 0, true); // extra
    view.setUint16(at + 32, 0, true); // comment
    view.setUint16(at + 34, 0, true); // disk
    view.setUint16(at + 36, 0, true); // internal attributes
    view.setUint32(at + 38, 0, true); // external attributes
    view.setUint32(at + 42, offsets[i], true);
    out.set(names[i], at + 46);
    at += 46 + names[i].length;
  }

  view.setUint32(at, END_SIGNATURE, true);
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, 0, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  view.setUint16(at + 20, 0, true);
  return out;
}

/**
 * Reads a STORE zip through its central directory (the way every unzip tool does): the entries in directory order, each CRC checked.
 * Throws when the bytes are not a zip this module could have written (no end record, a compressed entry, a bad CRC): it is the
 * reader the tests (and the e2e check of a download) use, not a general unzip.
 */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === END_SIGNATURE) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Not a zip: no end-of-central-directory record.");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) throw new Error("Not a zip: bad central directory entry.");
    const method = view.getUint16(at + 10, true);
    if (method !== 0) throw new Error(`Unsupported compression method ${method} (this reader reads stored entries only).`);
    const crc = view.getUint32(at + 16, true);
    const length = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (view.getUint32(local, true) !== LOCAL_SIGNATURE) throw new Error(`Not a zip: bad local header for ${path}.`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const content = bytes.slice(start, start + length);
    if (crc32(content) !== crc) throw new Error(`Bad CRC for ${path}.`);
    entries.push({ path, content });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
