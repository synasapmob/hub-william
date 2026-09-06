import type { ReactNode } from "react";
import { Download, FileDown } from "lucide-react";

import CopyCommand from "@/components/copy-command";
import InstallCommands from "@/components/install-commands";
import Flex from "@/components/ui/flex";
import catalogService, { type CatalogEntry } from "@/services/catalog";
import { downloadText } from "@/utils/utils.download";

const action =
  "flex items-center gap-1.5 rounded-lg border border-zinc-200/80 bg-card px-2.5 py-1.5 font-mono text-[11px] text-zinc-700 transition-colors hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden";

const prose = "text-zinc-600 text-xs/relaxed";

interface InstallOptionProps {
  /** Its place in the list, because these are alternatives rather than steps. */
  index: number;
  title: string;
  children: ReactNode;
}

function InstallOption({ index, title, children }: InstallOptionProps) {
  return (
    <div className="space-y-2">
      <p className="font-mono text-[11px] font-medium text-zinc-500">
        <span className="text-zinc-400">{index}.</span> {title}
      </p>

      {children}
    </div>
  );
}

interface CatalogCanvasEntryInstallProps {
  entry: CatalogEntry;
}

/**
 * Three ways to get this document, written out rather than hidden behind tabs.
 *
 * They are alternatives, not steps, and which one a reader wants is decided
 * before they arrive: somebody saving one contract to read takes the button,
 * somebody pointing an agent at the catalogue takes the command, somebody
 * setting up a machine takes the installer. A tab strip made the other two
 * invisible and turned "what are my options" into a thing you discover by
 * clicking.
 *
 * The archive is the file the build emitted, fetched over the network exactly
 * as `curl` fetches it. Zipping the bundled catalogue in the browser instead
 * would have worked offline, and was wrong: this app inlines only the documents
 * it renders, so a folder holding anything else — a `registry.yaml` a contract
 * reads, a skill's `references/` — came out short. One artefact cannot disagree
 * with itself.
 */
export default function CatalogCanvasEntryInstall({
  entry,
}: CatalogCanvasEntryInstallProps) {
  const archive = catalogService.rootArchive(entry);
  const fileName = catalogService.fileName(entry);
  const { destination } = catalogService.usage(entry);

  return (
    <div className="space-y-4">
      <InstallOption index={1} title="Download directly">
        <Flex className="items-center gap-2 flex-wrap">
          {/* The document is already in the bundle, so saving it is a blob and
              not a request — the one download here that works offline. */}
          <button
            type="button"
            className={action}
            onClick={() => downloadText(fileName, entry.source)}
          >
            <FileDown aria-hidden="true" className="size-3.5" />
            {fileName}
          </button>

          <a href={archive.url} download={archive.name} className={action}>
            <Download aria-hidden="true" className="size-3.5" />
            {archive.name}
            <span className="text-muted-foreground">
              {archive.fileCount} files
            </span>
          </a>
        </Flex>
      </InstallOption>

      <InstallOption index={2} title="Download with curl">
        <CopyCommand command={`curl -O ${catalogService.documentUrl(entry)}`} />

        <CopyCommand command={`curl -O ${archive.url}`} />
      </InstallOption>

      {/* The one thing a download cannot carry. The harness addresses its
          contracts by path, so a file saved anywhere else is a file no agent
          will ever open — which is the failure that looks like the catalogue
          not working. */}
      <div className="space-y-2">
        <p className={prose}>
          Either way it is read from{" "}
          <code className="font-mono text-[11px] break-all text-zinc-800">
            {destination}
          </code>
          , so an archive goes back to the checkout it came from:
        </p>

        <CopyCommand command={`unzip -o ${archive.name} -d ~/.hub-william`} />
      </div>

      <InstallOption index={3} title="Install the whole catalogue">
        <InstallCommands />

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          <code className="font-mono">init</code> draws the catalogue as a
          picker, so this document is one of the boxes you tick — and the
          installer keeps every document current, registers the skills and
          servers beside them, and knows how to undo itself.
        </p>
      </InstallOption>
    </div>
  );
}
