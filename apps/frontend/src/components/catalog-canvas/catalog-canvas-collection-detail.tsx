import { useState, type ReactNode } from "react";
import { Download, GitPullRequest } from "lucide-react";

import Flex from "@/components/ui/flex";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import catalogService, {
  GITHUB_REPOSITORY_URL,
  type CatalogCollection,
} from "@/services/catalog";

import CatalogCanvasCollectionFiles from "./catalog-canvas-collection-files";
import CatalogCanvasCollectionUsage from "./catalog-canvas-collection-usage";
import CatalogCanvasToolUsage from "./catalog-canvas-tool-usage";

interface CollectionSectionProps {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}

function CollectionSection({
  label,
  action,
  children,
}: CollectionSectionProps) {
  return (
    <section className="space-y-2.5">
      <Flex className="items-center justify-between gap-3">
        <h3 className="font-mono text-xs font-semibold tracking-wider text-zinc-700 uppercase">
          {label}
        </h3>

        {action}
      </Flex>

      {children}
    </section>
  );
}

interface CatalogCanvasCollectionDetailProps {
  collection: CatalogCollection | null;
  onOpenChange: (open: boolean) => void;
}

function usageSectionLabel(collection: CatalogCollection) {
  if (collection.section !== "tools") return "How to use";
  if (collection.id === "gateway") return "How to install and use";
  return "How to install";
}

/** One sheet for a whole functional collection instead of one per source file. */
export default function CatalogCanvasCollectionDetail({
  collection,
  onOpenChange,
}: CatalogCanvasCollectionDetailProps) {
  const [shown, setShown] = useState(collection);

  if (collection && collection !== shown) setShown(collection);

  if (!shown) {
    return <Sheet open={false} onOpenChange={onOpenChange} />;
  }

  const archive = catalogService.collectionArchive(shown);
  const files = catalogService.collectionFiles(shown);
  const isTools = shown.section === "tools";

  return (
    <Sheet open={collection !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 data-[side=right]:md:max-w-160"
      >
        <SheetHeader className="border-b border-zinc-100 bg-zinc-50/50 px-6 py-5 pr-14">
          <SheetTitle className="text-xl font-bold tracking-tight">
            {shown.label}
          </SheetTitle>

          <SheetDescription className="mt-1 text-sm/relaxed">
            {shown.summary}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          <CollectionSection label="Introduction">
            <p className="text-zinc-600 text-sm/relaxed">{shown.summary}</p>
          </CollectionSection>

          <CollectionSection
            label={`Files (${files.length})`}
            action={
              <a
                href={archive.url}
                download={archive.name}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-2 font-mono text-[11px] font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
              >
                <Download aria-hidden="true" className="size-3.5" />
                Download all ({archive.fileCount})
              </a>
            }
          >
            <CatalogCanvasCollectionFiles files={files} />
          </CollectionSection>

          <CollectionSection label={usageSectionLabel(shown)}>
            {isTools ? (
              <CatalogCanvasToolUsage collection={shown} />
            ) : (
              <CatalogCanvasCollectionUsage collection={shown} />
            )}
          </CollectionSection>
        </div>

        <Flex className="items-center gap-2 flex-wrap border-t border-zinc-100 bg-zinc-50/50 px-6 py-4 text-xs text-muted-foreground">
          <a
            href={GITHUB_REPOSITORY_URL}
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
