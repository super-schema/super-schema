/**
 * Reads the entries of a zip download through its central directory, with Node's Buffer only (no library, and independent of the app's
 * own zip writer, so a bug there is not mirrored here). Stored entries only: what "Download all" writes. Throws on anything else.
 */
export function readZipDirectory(zip: Buffer): Map<string, string> {
  const END = 0x06054b50;
  const CENTRAL = 0x02014b50;
  const LOCAL = 0x04034b50;
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip: no end-of-central-directory record");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== CENTRAL) throw new Error("not a zip: bad central directory entry");
    const method = zip.readUInt16LE(at + 10);
    if (method !== 0) throw new Error(`zip entry is compressed (method ${method}); only stored entries are expected`);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    if (zip.readUInt32LE(local) !== LOCAL) throw new Error(`not a zip: bad local header for ${name}`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    entries.set(name, zip.subarray(start, start + size).toString("utf8"));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
