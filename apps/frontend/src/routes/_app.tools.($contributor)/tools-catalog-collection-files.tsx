import { FileText } from "lucide-react";

import Flex from "@/components/ui/flex";
import type { CatalogCollectionFile } from "@/services/catalog/catalog-types";
import { downloadText } from "@/utils/utils.download";

interface ToolsCatalogCollectionFilesProps {
  files: CatalogCollectionFile[];
}

/** Every source document in a collection: the path opens it in a new tab, the text beside it saves it. */
export default function ToolsCatalogCollectionFiles({
  files,
}: ToolsCatalogCollectionFilesProps) {
  return (
    <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200/80 bg-card">
      {files.map((file) => (
        <li key={file.path}>
          <Flex className="w-full items-start gap-3 px-4 py-3 text-left">
            <FileText
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-slate-400"
            />

            <div className="min-w-0 flex-1">
              <p className="font-medium text-zinc-900 text-sm/normal">
                {file.title}
              </p>

              <p className="mt-2 line-clamp-3 text-muted-foreground text-xs/relaxed">
                {file.description}
              </p>

              <Flex className="mt-1.5 items-baseline gap-1.5 font-mono text-[10px]">
                <a
                  href={file.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 truncate text-blue-500 underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
                >
                  {file.path}
                </a>

                <button
                  type="button"
                  className="shrink-0 rounded-sm whitespace-nowrap text-slate-500 underline hover:text-indigo-600 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
                  onClick={() => downloadText(file.name, file.source)}
                >
                  (click here to download)
                </button>
              </Flex>
            </div>
          </Flex>
        </li>
      ))}
    </ul>
  );
}
