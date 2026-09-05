import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  FileText,
  GitPullRequest,
} from "lucide-react";

import CopyBlock from "@/components/copy-block";
import CopyCommand from "@/components/copy-command";
import Flex from "@/components/flex";
import MarkdownView from "@/components/markdown";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import catalogService, {
  AREA_LABELS,
  type CatalogEntry,
} from "@/services/catalog";
import { areaTone } from "@/styles/library/library-index";
import { copyText } from "@/utils/utils.clipboard";

interface CopySourceButtonProps {
  source: string;
}

/**
 * The exact file, for pasting into an agent.
 *
 * The rendered view is for reading; a contract handed to an agent has to be the
 * bytes on disk, because Markdown rendering silently drops anything the
 * sanitiser does not allow.
 */
function CopySourceButton({ source }: CopySourceButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;

    const timer = setTimeout(() => setCopied(false), 2_000);

    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    setCopied(await copyText(source));
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="flex items-center gap-1.5 rounded-lg border border-border bg-zinc-50 px-2.5 py-1 font-mono text-[11px] text-zinc-700 transition-colors hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
    >
      {copied ? (
        <Check aria-hidden="true" className="size-3.5 text-emerald-600" />
      ) : (
        <Copy aria-hidden="true" className="size-3.5" />
      )}
      {copied ? "Copied" : "Copy source"}
    </button>
  );
}

interface EntryDetailProps {
  entry: CatalogEntry | null;
  onOpenChange: (open: boolean) => void;
}

export default function EntryDetail({ entry, onOpenChange }: EntryDetailProps) {
  // The sheet keeps rendering the entry it was opened with while it slides out.
  // Unmounting the content the moment `entry` goes null is what made closing
  // read as a cut rather than a transition: Radix was left animating nothing.
  const [shown, setShown] = useState(entry);

  useEffect(() => {
    if (entry) setShown(entry);
  }, [entry]);

  if (!shown) {
    return <Sheet open={false} onOpenChange={onOpenChange} />;
  }

  // A template is written to be pasted, and it is mostly `<!-- instructions -->`
  // that a Markdown renderer drops on sight — so it is shown verbatim, as the
  // snippet it is, rather than as a page of bare headings.
  const isTemplate = shown.category === "TEMPLATES";

  return (
    <Sheet open={entry !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        // The generated primitive caps a right sheet at `max-w-sm` through a
        // `data-[side=right]:sm:` variant, so a plain `sm:max-w-*` here loses to
        // it on specificity rather than being merged away.
        className="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:max-w-120"
      >
        <SheetHeader className="flex-row items-center gap-2 border-b border-zinc-100 bg-zinc-50/50 px-6 py-4 pr-14">
          <SheetTitle className="sr-only">{shown.name}</SheetTitle>
          <SheetDescription className="sr-only">
            {shown.description}
          </SheetDescription>

          <p className={areaTone({ area: shown.area }).badge()}>
            {AREA_LABELS[shown.area]}
          </p>

          <p className="font-mono text-xs text-slate-400">{shown.category}</p>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          <div>
            <h2 className="text-xl font-bold tracking-tight">{shown.name}</h2>

            <Flex
              gap="md"
              wrap
              className="mt-2 font-mono text-xs text-muted-foreground"
            >
              <span className="flex items-center gap-1">
                <FileText aria-hidden="true" className="size-3.5" />
                {shown.lineCount} lines
              </span>

              <a
                href={catalogService.sourceUrl(shown)}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-indigo-600 hover:underline"
              >
                {shown.id}.md
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>

              {/* A template already carries a copy control on its snippet;
                  two buttons for the same string is one too many. */}
              {isTemplate ? null : <CopySourceButton source={shown.body} />}
            </Flex>
          </div>

          {/* The catalogue publishes what the machine installs, so the way to
              use an entry is to install the harness, not to copy a snippet. */}
          <div className="space-y-3 rounded-xl border border-zinc-200/80 bg-zinc-50 p-4">
            <p className="font-mono text-[11px] font-semibold tracking-wider text-zinc-700 uppercase">
              Install this catalogue
            </p>

            <CopyCommand command="npx hub-william install" />
          </div>

          {isTemplate ? (
            <CopyBlock source={shown.body} />
          ) : (
            <MarkdownView source={shown.body} />
          )}
        </div>

        <Flex
          gap="sm"
          wrap
          className="border-t border-zinc-100 bg-zinc-50/50 px-6 py-4 text-xs text-muted-foreground"
        >
          <a
            href={catalogService.contributeUrl(shown.category)}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 font-mono text-[11px] text-indigo-600 hover:underline"
          >
            <GitPullRequest aria-hidden="true" className="size-3.5" />
            Contribute one of your own
          </a>
        </Flex>
      </SheetContent>
    </Sheet>
  );
}
