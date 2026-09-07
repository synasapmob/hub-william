import { lazy, Suspense, type ReactNode } from "react";

import type { CatalogEntry } from "@/services/catalog";

interface MarkdownViewProps {
  source: string;
  entry: CatalogEntry;
}

// react-markdown, remark-gfm and the sanitiser are ~51 kB gzipped and only the
// catalogue sheet renders markdown, so the whole renderer is a separate chunk
// fetched when a document is opened rather than freight on every page.
const MarkdownRenderer = lazy(() => import("./markdown-renderer"));

function MarkdownFallback() {
  return (
    <p className="text-sm text-muted-foreground" aria-live="polite">
      Loading document…
    </p>
  );
}

/**
 * The only supported way to render a catalogue document.
 *
 * Everything that shows contributed Markdown goes through this. A second path
 * that renders "just a preview" is worse than none, because it shows an author
 * something safe while the published page shows something else.
 */
export default function MarkdownView({
  source,
  entry,
}: MarkdownViewProps): ReactNode {
  return (
    <Suspense fallback={<MarkdownFallback />}>
      <MarkdownRenderer source={source} entry={entry} />
    </Suspense>
  );
}
