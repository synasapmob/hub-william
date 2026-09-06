import { zipSync, strToU8 } from "fflate";

/**
 * Saving files without a server.
 *
 * The catalogue is already inlined in the bundle, so a download is a `Blob`
 * built from memory rather than a request — it works offline, it works on a
 * static host, and it cannot 404. Nothing here talks to the network.
 */

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  anchor.click();

  // Revoking immediately can cancel the download in Safari, which reads the
  // URL after the click returns. A task later is enough and still bounded.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** One document, as the `.md` file it already is on disk. */
export function downloadText(filename: string, contents: string) {
  save(new Blob([contents], { type: "text/markdown;charset=utf-8" }), filename);
}

export interface DownloadableFile {
  /** Path inside the archive, so the folders survive the round trip. */
  path: string;
  contents: string;
}

/**
 * Several documents, as a zip that keeps their paths.
 *
 * The paths matter more than the files: an agent reads `harness/tags/plan.md`
 * because of where it sits, so an archive that flattened everything into one
 * folder would be a pile of Markdown rather than something you can drop in.
 */
export function downloadZip(filename: string, files: DownloadableFile[]) {
  const entries: Record<string, Uint8Array> = {};

  for (const file of files) {
    entries[file.path] = strToU8(file.contents);
  }

  save(new Blob([zipSync(entries)], { type: "application/zip" }), filename);
}
