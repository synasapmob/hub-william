import {
  BadgeCheck,
  BookOpen,
  Files,
  GitPullRequest,
  Network,
  Plug,
  Sparkles,
  Tags,
  type LucideIcon,
} from "lucide-react";

import Center from "@/components/ui/center";
import Flex from "@/components/ui/flex";
import catalogService, { type CatalogCollection } from "@/services/catalog";

const collectionIcons: Record<string, LucideIcon> = {
  documents: BookOpen,
  evidences: BadgeCheck,
  github: GitPullRequest,
  gateway: Network,
  mcp: Plug,
  skills: Sparkles,
  tags: Tags,
  templates: Files,
};

interface CatalogCanvasCollectionCardProps {
  collection: CatalogCollection;
  onSelect: (collection: CatalogCollection) => void;
}

/** One functional domain, regardless of how many source folders feed it. */
export default function CatalogCanvasCollectionCard({
  collection,
  onSelect,
}: CatalogCanvasCollectionCardProps) {
  const CollectionIcon = collectionIcons[collection.id] ?? Files;
  const fileCount = catalogService.collectionFiles(collection).length;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(collection)}
        className="group flex w-full flex-col rounded-2xl border border-slate-200/90 bg-card p-4 text-left shadow-xs transition-all hover:border-indigo-300 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
      >
        <Flex className="items-start justify-between">
          <Center className="size-10 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-600 shadow-xs">
            <CollectionIcon aria-hidden="true" className="size-5" />
          </Center>

          <p className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono text-[11px] font-semibold text-slate-600">
            {fileCount} files
          </p>
        </Flex>

        <h3 className="mt-4 font-bold text-sm tracking-tight transition-colors group-hover:text-indigo-600">
          {collection.label.toUpperCase()}
        </h3>

        <p className="mt-0.5 text-muted-foreground text-xs">
          {collection.summary}
        </p>
      </button>
    </li>
  );
}
