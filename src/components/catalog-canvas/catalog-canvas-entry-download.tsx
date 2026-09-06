import { Download, FileDown } from "lucide-react";

import Flex from "@/components/ui/flex";
import catalogService, { type CatalogEntry } from "@/services/catalog";
import { downloadText, downloadZip } from "@/utils/utils.download";

const action =
  "flex items-center gap-1.5 rounded-lg border border-zinc-200/80 bg-card px-2.5 py-1.5 font-mono text-[11px] text-zinc-700 transition-colors hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden";

interface CatalogCanvasEntryDownloadProps {
  entry: CatalogEntry;
  /** Whose catalogue is open, so "all of them" means the one being read. */
  contributor: string | null;
}

/**
 * Take the document away, or take its whole category.
 *
 * Both are built from memory: the catalogue is already inlined in the bundle,
 * so neither button makes a request and both work offline. The archive keeps
 * each file's catalogue path, because where a contract sits is part of what it
 * is — an agent loads `harness/tags/plan.md` by that path.
 *
 * Downloading is for reading and for vendoring into another repository. It is
 * not installing: these files still have to land in the right place under the
 * right name before an agent reads them, which is what the machine installer
 * is for.
 */
export default function CatalogCanvasEntryDownload({
  entry,
  contributor,
}: CatalogCanvasEntryDownloadProps) {
  const files = catalogService.filesInCategory(entry.category, contributor);
  const archive = `${entry.category.toLowerCase()}.zip`;

  return (
    <Flex className="flex-wrap items-center gap-2">
      <button
        type="button"
        className={action}
        onClick={() =>
          downloadText(catalogService.fileName(entry), entry.source)
        }
      >
        <FileDown aria-hidden="true" className="size-3.5" />
        Download this file
      </button>

      <button
        type="button"
        className={action}
        onClick={() => downloadZip(archive, files)}
      >
        <Download aria-hidden="true" className="size-3.5" />
        Download all {entry.category.toLowerCase()}
        <span className="text-muted-foreground">({files.length})</span>
      </button>
    </Flex>
  );
}
