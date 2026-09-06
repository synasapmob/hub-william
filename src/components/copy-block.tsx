import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

import { copyText } from "@/utils/utils.clipboard";

interface CopyBlockProps {
  /** The document, verbatim — including anything Markdown would swallow. */
  source: string;
}

/**
 * A whole document as a copyable snippet.
 *
 * Templates are written to be pasted, not read: a pull-request template is
 * mostly `<!-- instructions -->`, and a Markdown renderer drops every one of
 * them, leaving a page of bare headings that would be useless in the pull
 * request it was copied into. So the raw text is shown as-is.
 *
 * Wrapped rather than scrolled sideways. What gets copied is the string, not
 * what is on screen, so wrapping costs nothing and a comment that runs off the
 * right edge is a comment nobody reads.
 */
export default function CopyBlock({ source }: CopyBlockProps) {
  const [copied, setCopied] = useState(false);

  // The tick is feedback, not a final state. It has to fall back to the copy
  // icon or the button reads as spent, and a second copy looks unavailable.
  useEffect(() => {
    if (!copied) return;

    const timer = setTimeout(() => setCopied(false), 2_000);

    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    setCopied(await copyText(source));
  }

  return (
    <div className="relative">
      <pre className="max-h-160 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 p-4 pt-12 font-mono text-[11px] leading-relaxed wrap-break-word whitespace-pre-wrap text-zinc-100">
        <code>{source}</code>
      </pre>

      <button
        type="button"
        onClick={() => void copy()}
        className="absolute top-3 right-3 flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900/90 px-2.5 py-1.5 font-mono text-[11px] text-zinc-200 backdrop-blur-xs transition-colors hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-hidden"
      >
        {copied ? (
          <Check aria-hidden="true" className="size-3.5 text-emerald-400" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
