/**
 * "Download all" for a file set: ONE zip that keeps every file under its path (`createZip`, no library). Saving the files one by one
 * flattened the paths, which breaks what the files say about each other: a Protobuf `import "D/P/Record.proto"` and a Java package
 * directory only work where the directories are kept. Client-side only: it uses `Blob`, `URL.createObjectURL` and an anchor click.
 */

import { createZip } from "@/lib/zip-store";

export interface DownloadableFile {
  path: string;
  content: string;
}

/** How long the blob URL stays valid after the download was started. */
export const REVOKE_DELAY_MS = 1000;

/** `<entity>-<target>.zip`, with anything a file system dislikes in the entity name replaced by `_`. */
export function zipFileName(entityName: string, target: string): string {
  const safe = (text: string) => text.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim();
  return `${safe(entityName) || "schema"}-${safe(target) || "files"}.zip`;
}

/** The zip of `files`, each at its own path. */
export function zipOfFiles(files: ReadonlyArray<DownloadableFile>): Uint8Array {
  return createZip(files.map(({ path, content }) => ({ path, content })));
}

export async function downloadFilesAsZip(files: ReadonlyArray<DownloadableFile>, fileName: string): Promise<void> {
  const bytes = zipOfFiles(files);
  // (a copy into a plain ArrayBuffer: a Blob part must not be a view onto a shared buffer)
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/zip" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  // Not at once: a browser starts reading the blob after the click returns, and a URL revoked before that yields an empty download.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
