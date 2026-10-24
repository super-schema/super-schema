/**
 * Reading the generated artifact off the Schemas tab, without Playwright in it (so it can be unit tested against a fake page).
 *
 * A version of several files shows ONE file at a time in the code preview (one per entity; a JSON Schema inline enum has a file of its
 * own), so the text of the whole artifact is every file in turn, joined the way `SchemaVersion.output` joins them. A version of one
 * file (the DB targets, an old version, a stand-alone entity) has no file list and is its single preview.
 */

export interface PreviewSource {
  /** The paths of the file list's entries, in list order; empty when the version is one plain preview. */
  filePaths(): Promise<string[]>;
  /** Shows the file with this path in the code preview and resolves once the preview shows it (it throws when no such file is listed). */
  select(path: string): Promise<void>;
  /** The visible code preview's text, line-number gutter stripped. */
  code(): Promise<string>;
}

/** The stored `output` form of a file set: `===== path =====` and the content, files separated by a blank line. */
export function bundlePreviewFiles(files: ReadonlyArray<{ path: string; content: string }>): string {
  return files.map((file) => `===== ${file.path} =====\n${file.content.trimEnd()}`).join("\n\n");
}

const BUNDLE_HEADER = /^===== (.+) =====$/;

/**
 * The files of a bundle (`bundlePreviewFiles`, `readPreview`'s text): `{ path, content }` in bundle order. Text without a header line is
 * ONE file with the path "" (a single plain preview, as it is), so a caller treats a single file and a set alike.
 */
export function splitBundle(text: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; lines: string[] }> = [];
  const before: string[] = [];
  for (const line of text.split("\n")) {
    const header = BUNDLE_HEADER.exec(line);
    if (header) files.push({ path: header[1], lines: [] });
    else if (files.length > 0) files[files.length - 1].lines.push(line);
    else before.push(line);
  }
  if (files.length === 0) return [{ path: "", content: text }];
  const out = files.map((file) => ({ path: file.path, content: file.lines.join("\n").trimEnd() }));
  const lead = before.join("\n").trimEnd();
  return lead.trim() === "" ? out : [{ path: "", content: lead }, ...out];
}

/**
 * The whole artifact: the single preview as it is, or every file of the list in turn (the first file is selected again afterwards). Each
 * file is selected by its PATH from one snapshot of the list; when the list changed while it was read (the versions reloaded under it)
 * the read throws instead of returning old and new content mixed, and the caller reads again.
 */
export async function readPreviewFrom(source: PreviewSource): Promise<string> {
  const paths = await source.filePaths();
  if (paths.length === 0) return source.code();
  const files: Array<{ path: string; content: string }> = [];
  for (const path of paths) {
    await source.select(path);
    files.push({ path, content: await source.code() });
  }
  await source.select(paths[0]);
  const after = await source.filePaths();
  if (after.length !== paths.length || after.some((path, i) => path !== paths[i])) {
    throw new Error("the file list changed while the artifact was read");
  }
  return bundlePreviewFiles(files);
}

/** A cheap fingerprint of what is on show: the file list and the text of the file selected now (no clicking through the files). */
export async function previewSignature(source: PreviewSource): Promise<string> {
  const paths = await source.filePaths();
  return `${paths.join("\n")}\n--\n${await source.code()}`;
}

export interface SettleOptions {
  /** The artifact before the regeneration (a full read) and its signature. */
  previous: string;
  previousSignature: string;
  /** A full read (clicks through the files); may throw, which counts as "not settled yet". */
  read: () => Promise<string>;
  /** The cheap signature; may throw, which counts as "changed". */
  signature: () => Promise<string>;
  wait: (ms: number) => Promise<void>;
  /** Total budget = `rounds` x `intervalMs` (default 40 x 200 ms = 8 s). */
  rounds?: number;
  intervalMs?: number;
  /** A full read at least every this many rounds, so a change in a file that is not on show is seen within about a second. */
  fullEvery?: number;
}

/**
 * Waits until the artifact differs from `previous` (or the budget is spent) and returns what was last read. The cost of a round is
 * one cheap signature; the full read (one click per file) happens when the signature changed since it was last seen, every
 * `fullEvery` rounds, and while there is nothing readable yet.
 */
export async function settlePreview(opts: SettleOptions): Promise<string> {
  const { previous, previousSignature, read, signature, wait, rounds = 40, intervalMs = 200, fullEvery = 5 } = opts;
  const safe = async (fn: () => Promise<string>, fallback: string) => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };
  let text = await safe(read, "");
  let seen = previousSignature;
  for (let round = 1; round <= rounds && (text === previous || text === ""); round += 1) {
    await wait(intervalMs);
    const now = await safe(signature, "\u0000changed");
    if (text === "" || now !== seen || round % fullEvery === 0) {
      seen = now;
      text = await safe(read, "");
    }
  }
  return text;
}
