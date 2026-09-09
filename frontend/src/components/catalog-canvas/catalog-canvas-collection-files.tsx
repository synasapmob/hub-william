import { Download, FileText } from "lucide-react";

import Flex from "@/components/ui/flex";
import { type CatalogCollectionFile } from "@/services/catalog";
import { downloadText } from "@/utils/utils.download";

interface CatalogCanvasCollectionFilesProps {
  files: CatalogCollectionFile[];
}

/** Every source document in a collection, with direct open and download actions. */
export default function CatalogCanvasCollectionFiles({
  files,
}: CatalogCanvasCollectionFilesProps) {
  return (
    <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200/80 bg-card">
      {files.map((file) => (
        <li key={file.path}>
          <Flex className="w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-hidden">
            <FileText
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-slate-400"
            />

            <div className="min-w-0 flex-1">
              <Flex className="items-start justify-between gap-3">
                <p className="font-medium text-zinc-900 text-sm/normal">
                  {file.title}
                </p>

                <button
                  type="button"
                  aria-label={`Download ${file.name}`}
                  className="rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
                  onClick={() => downloadText(file.name, file.source)}
                >
                  <Download
                    aria-hidden="true"
                    className="size-5 text-slate-400 hover:text-indigo-600"
                  />
                </button>
              </Flex>

              <p className="mt-2 line-clamp-3 text-muted-foreground text-xs/relaxed">
                {file.description}
              </p>

              <a
                href={file.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1.5 block truncate font-mono text-[10px] text-blue-500 underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
              >
                {file.path}
              </a>
            </div>
          </Flex>
        </li>
      ))}
    </ul>
  );
}
