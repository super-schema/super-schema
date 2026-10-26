/**
 * The bundled form of a generated file list: a single file is its bare content, several are `===== path =====` blocks separated by a blank line.
 * It is `SchemaVersion.output`. Pure and import-free so the code that REBUILDS a bundle from a smaller file list (the read-boundary redaction of
 * stored versions, KD-046) uses exactly the function the generator used and the two can never drift apart.
 */
export function bundleFileContents(files: ReadonlyArray<{ path: string; content: string }>): string {
  if (files.length === 1) {
    return files[0].content;
  }

  return files.map((file) => `===== ${file.path} =====\n${file.content.trimEnd()}`).join("\n\n");
}
