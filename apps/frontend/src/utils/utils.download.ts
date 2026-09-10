/**
 * Saving a document without a server.
 *
 * The catalogue is already inlined in the bundle, so saving one file is a
 * `Blob` built from memory rather than a request — it works offline, it works
 * on a static host, and it cannot 404. Nothing here talks to the network.
 *
 * An archive is deliberately not built here. Several files zipped in the
 * browser would be a second answer to "what is in this folder", and the build
 * already emits one at `/catalog/<folder>.zip` for `curl` to fetch; the two
 * drifted apart the moment a folder held anything this app does not render. A
 * download button is a link to that file instead.
 */

/** One catalogue text file, with its original filename and bytes. */
export function downloadText(filename: string, contents: string) {
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  anchor.click();

  // Revoking immediately can cancel the download in Safari, which reads the
  // URL after the click returns. A task later is enough and still bounded.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
