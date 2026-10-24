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
  /** Shows the file at `index` of the list in the code preview and resolves once the preview shows it. */
  select(index: number): Promise<void>;
  /** The visible code preview's text, line-number gutter stripped. */
  code(): Promise<string>;
}

/** The stored `output` form of a file set: `===== path =====` and the content, files separated by a blank line. */
export function bundlePreviewFiles(files: ReadonlyArray<{ path: string; content: string }>): string {
  return files.map((file) => `===== ${file.path} =====\n${file.content.trimEnd()}`).join("\n\n");
}

/** The whole artifact: the single preview as it is, or every file of the list in turn (the first file is selected again afterwards). */
export async function readPreviewFrom(source: PreviewSource): Promise<string> {
  const paths = await source.filePaths();
  if (paths.length === 0) return source.code();
  const files: Array<{ path: string; content: string }> = [];
  for (let index = 0; index < paths.length; index += 1) {
    await source.select(index);
    files.push({ path: paths[index], content: await source.code() });
  }
  await source.select(0);
  return bundlePreviewFiles(files);
}
