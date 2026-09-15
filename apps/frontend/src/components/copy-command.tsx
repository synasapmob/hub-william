import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

import Flex from "@/components/ui/flex";
import { copyText } from "@/utils/utils.clipboard";

interface CopyCommandProps {
  command: string;
}

/**
 * A single shell command, on the terminal's own paper, with a copy control.
 *
 * The `$` is decorative and deliberately not part of what gets copied — a
 * prompt character pasted into a real shell is a command not found.
 */
export default function CopyCommand({ command }: CopyCommandProps) {
  const [copied, setCopied] = useState(false);

  // The tick is feedback, not a final state. It has to fall back to the copy
  // icon or the button reads as spent, and a second copy looks unavailable.
  useEffect(() => {
    if (!copied) return;

    const timer = setTimeout(() => setCopied(false), 2_000);

    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    setCopied(await copyText(command));
  }

  return (
    <Flex className="items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-xs text-zinc-100">
      <code className="flex min-w-0 items-center gap-2 overflow-x-auto">
        <span aria-hidden="true" className="text-zinc-500 select-none">
          $
        </span>
        {command}
      </code>

      <button
        type="button"
        onClick={() => void copy()}
        className="flex shrink-0 items-center gap-1 rounded px-1 text-[11px] text-zinc-400 transition-colors hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-hidden"
      >
        {copied ? (
          <Check aria-hidden="true" className="size-3.5 text-emerald-400" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
    </Flex>
  );
}
