import { ChevronDown, Download, ExternalLink } from "lucide-react";

import CopyCommand from "@/components/copy-command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import catalogService, {
  type CatalogArchive,
  type CatalogSection,
} from "@/services/catalog";
import { toolbarTrigger } from "@/utils/utils.toolbar";

interface ArchiveLinkProps {
  archive: CatalogArchive;
  description: string;
}

function ArchiveLink({ archive, description }: ArchiveLinkProps) {
  return (
    <a
      href={archive.url}
      download={archive.name}
      className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
    >
      <Download aria-hidden="true" className="mt-0.5 size-3.5 text-zinc-500" />

      <div className="min-w-0 flex-1">
        <p className="font-mono text-xs text-foreground">{archive.name}</p>

        <p className="text-[11px] text-muted-foreground">
          {description} · {archive.fileCount} files
        </p>
      </div>
    </a>
  );
}

interface CatalogCanvasDownloadProps {
  /** Which canvas is being read, so "this one" means what is on screen. */
  section: CatalogSection;
  /** Whose catalogue is open, or null for the shared one. */
  contributor: string | null;
}

/**
 * Take the whole canvas, rather than one document at a time.
 *
 * The sheet offers a document and the root it sits in, which is the right
 * granularity while you are reading one. This is the other end: somebody
 * vendoring the catalogue into another repository, or pointing an agent at it,
 * wants all of it and should not have to open twenty-five sheets to get there.
 *
 * Both archives are files the build emitted, so a click and the command below
 * fetch identical bytes. `index.json` is offered beside them because it is what
 * an agent should be handed — every document with its own URL, so nothing has
 * to crawl the site or guess a path.
 */
export default function CatalogCanvasDownload({
  section,
  contributor,
}: CatalogCanvasDownloadProps) {
  const canvas = catalogService.sectionArchive(section, contributor);
  const everything = catalogService.catalogArchive();
  // The section is `library`, and the folder it archives is `libraries`; a row
  // describing what you are about to download says it the way a reader would.
  const noun = section === "tools" ? "tools" : "library";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={toolbarTrigger}>
          <Download aria-hidden="true" className="size-4" />
          Download
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </button>
      </PopoverTrigger>

      {/* The same width as the catalogue switcher beside it, which is also what
          keeps it inside a 320px viewport. */}
      <PopoverContent align="end" className="w-72 space-y-2 p-2">
        <div>
          <ArchiveLink
            archive={canvas}
            description={
              contributor ? `@${contributor}'s ${noun}` : `The shared ${noun}`
            }
          />

          <ArchiveLink archive={everything} description="Every catalogue" />
        </div>

        <CopyCommand command={`curl -O ${canvas.url}`} />

        <p className="px-2 text-[11px] leading-relaxed text-muted-foreground">
          An agent is better handed{" "}
          <a
            href={catalogService.indexUrl()}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-indigo-600 hover:underline"
          >
            index.json
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
          , which lists every document and archive with its own URL.
        </p>
      </PopoverContent>
    </Popover>
  );
}
