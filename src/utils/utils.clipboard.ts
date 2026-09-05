import { toast } from "sonner";

/**
 * Write text to the clipboard, and say so when it fails.
 *
 * The clipboard rejects on an insecure origin, in a page without focus, and
 * wherever the reader has denied the permission. A silent failure there is the
 * worst outcome: the tick appears, the paste is stale, and nobody finds out
 * until the wrong thing is in a pull request.
 *
 * Returns whether the write landed, so a caller can decide whether to show its
 * own confirmation.
 */
export async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);

    return true;
  } catch {
    toast.error("Copying failed. Select the text and copy it manually.");

    return false;
  }
}
