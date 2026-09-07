import { useEffect, useState, type ReactNode } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  FileText,
  GitPullRequest,
} from "lucide-react";

import Flex from "@/components/ui/flex";
import CopyBlock from "@/components/copy-block";
import MarkdownView from "@/components/markdown";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import catalogService, {
  groupLabel,
  type CatalogEntry,
} from "@/services/catalog";
import { rootSlots } from "@/utils/utils.tone";
import { copyText } from "@/utils/utils.clipboard";

import CatalogCanvasEntryInstall from "./catalog-canvas-entry-install";
import CatalogCanvasEntryUsage from "./catalog-canvas-entry-usage";

const panel = "rounded-xl border border-zinc-200/80 bg-zinc-50 p-4";

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

interface EntrySectionProps {
  label: string;
  children: ReactNode;
}

/**
 * One headed block of the sheet.
 *
 * The sheet answers three questions in a fixed order — what is this, how do I
 * get it onto a machine, what do I type to use it — and a reader who learned
 * that order should find it again on the next document. Naming the blocks is
 * what makes the order legible rather than incidental.
 */
function EntrySection({ label, children }: EntrySectionProps) {
  return (
    <div className="space-y-2.5">
      <p className="font-mono text-[11px] font-semibold tracking-wider text-zinc-700 uppercase">
        {label}
      </p>

      {children}
    </div>
  );
}

interface CatalogCanvasEntryDetailProps {
  entry: CatalogEntry | null;
  onOpenChange: (open: boolean) => void;
}

export default function CatalogCanvasEntryDetail({
  entry,
  onOpenChange,
}: CatalogCanvasEntryDetailProps) {
  // The sheet keeps rendering the entry it was opened with while it slides out.
  // Unmounting the content the moment `entry` goes null is what made closing
  // read as a cut rather than a transition: Radix was left animating nothing.
  // Adjusted during render rather than in an effect: React re-runs this
  // component immediately with the new value and never commits the stale one,
  // where an effect would paint the old entry for a frame first.
  const [shown, setShown] = useState(entry);

  if (entry && entry !== shown) setShown(entry);

  if (!shown) {
    return <Sheet open={false} onOpenChange={onOpenChange} />;
  }

  // A template is written to be pasted, and it is mostly `<!-- instructions -->`
  // that a Markdown renderer drops on sight — so it is shown verbatim, as the
  // snippet it is, rather than as a page of bare headings.
  //
  // A category is the folder's own name and folders here are lower case; this
  // read `"TEMPLATES"` and so was never true, which is why every template was
  // rendering as exactly the page of bare headings the line above warns about.
  // `rootLabel` is what upper-cases a category for display, and that is the
  // only place the shouting belongs.
  const isTemplate = shown.category === "templates";

  return (
    <Sheet open={entry !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        // The generated primitive caps a right sheet at `max-w-sm` through a
        // `data-[side=right]:sm:` variant, so a plain `sm:max-w-*` here loses to
        // it on specificity rather than being merged away.
        className="flex w-full flex-col gap-0 p-0 data-[side=right]:md:max-w-160"
      >
        <SheetHeader className="flex-row items-center gap-2 border-b border-zinc-100 bg-zinc-50/50 px-6 py-4 pr-14">
          <SheetTitle className="sr-only">{shown.name}</SheetTitle>
          <SheetDescription className="sr-only">
            {shown.description}
          </SheetDescription>

          <p className={rootSlots(shown.category).badge()}>
            {groupLabel(shown.group)}
          </p>

          <p className="font-mono text-xs text-slate-400">{shown.category}</p>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          <div>
            <h2 className="text-xl font-bold tracking-tight">{shown.name}</h2>

            <Flex className="items-center gap-3 flex-wrap mt-2 font-mono text-xs text-muted-foreground">
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
              {isTemplate ? null : <CopySourceButton source={shown.source} />}
            </Flex>
          </div>

          {/* The document's own opening paragraph, which is where these
              contracts state their purpose. Printed rather than left to the
              body below because a reader deciding whether to take a file
              should not have to start reading it to find out what it is. */}
          <EntrySection label="Introduction">
            <p className="text-zinc-600 text-sm/relaxed">{shown.description}</p>
          </EntrySection>

          <EntrySection label="How to install">
            <div className={panel}>
              <CatalogCanvasEntryInstall entry={shown} />
            </div>
          </EntrySection>

          <EntrySection label="How to use">
            <CatalogCanvasEntryUsage entry={shown} />
          </EntrySection>

          {isTemplate ? (
            <CopyBlock source={shown.source} />
          ) : (
            <MarkdownView source={shown.body} entry={shown} />
          )}
        </div>

        <Flex className="items-center gap-2 flex-wrap border-t border-zinc-100 bg-zinc-50/50 px-6 py-4 text-xs text-muted-foreground">
          <a
            href={catalogService.contributeUrl(shown)}
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
