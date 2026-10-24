/**
 * "Download all" for a file set. There is no zip library in the project, so the files are saved one after the other (a browser may ask
 * once to allow several downloads). Client-side only: it uses `Blob`, `URL.createObjectURL` and an anchor click.
 */

export interface DownloadableFile {
  path: string;
  content: string;
}

/** Pause between two downloads, so a browser does not fold them into one blocked burst. */
export const DOWNLOAD_GAP_MS = 100;

/**
 * One file name per path: directory separators become `_` (a browser would do so anyway, silently), and a name an earlier file already
 * took gets `-2`, `-3`, ... before its extension, so no file overwrites another.
 */
export function downloadNames(files: ReadonlyArray<Pick<DownloadableFile, "path">>): string[] {
  const used = new Set<string>();
  return files.map(({ path }) => {
    const flat = path.replace(/[\\/]+/g, "_") || "file";
    let name = flat;
    for (let n = 2; used.has(name); n += 1) {
      const dot = flat.lastIndexOf(".");
      name = dot > 0 ? `${flat.slice(0, dot)}-${n}${flat.slice(dot)}` : `${flat}-${n}`;
    }
    used.add(name);
    return name;
  });
}

function mimeTypeOf(path: string): string {
  if (/\.json$/i.test(path)) return "application/json";
  if (/\.ya?ml$/i.test(path)) return "text/yaml";
  return "text/plain";
}

export async function downloadFilesSequentially(files: ReadonlyArray<DownloadableFile>, gapMs: number = DOWNLOAD_GAP_MS): Promise<void> {
  const names = downloadNames(files);
  for (let i = 0; i < files.length; i += 1) {
    const url = URL.createObjectURL(new Blob([files[i].content], { type: `${mimeTypeOf(files[i].path)};charset=utf-8` }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = names[i];
    anchor.click();
    URL.revokeObjectURL(url);
    if (i < files.length - 1) await new Promise<void>((resolve) => setTimeout(resolve, gapMs));
  }
}
