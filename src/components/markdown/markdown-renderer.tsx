import {
  createContext,
  useContext,
  type ComponentProps,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import catalogService, { type CatalogEntry } from "@/services/catalog";

import { documentSchema } from "./markdown-schema";

// Catalogue documents arrive by pull request from whoever wants one in the
// catalogue, so every byte of one is treated as authored by a stranger.
//
// Three rules keep this file safe, and all three are one line away from being
// undone by a well-meaning refactor:
//
//   1. Never add rehype-raw. It is the single switch that turns escaped text
//      back into live HTML.
//   2. Never override urlTransform. react-markdown's default is what strips
//      javascript: and data: from href and src.
//   3. Never pass a component override that calls dangerouslySetInnerHTML.
//
// react-markdown renders to React elements rather than an HTML string, which is
// why those three rules are the whole story rather than the first layer of one.

/**
 * Injected markdown likes to write [Supabase docs](https://evil.tld). Printing
 * the host next to the text is a real control against that, and it costs one
 * line of layout.
 */
interface SafeLinkProps {
  href?: string | undefined;
  children?: ReactNode;
}

const MarkdownEntryContext = createContext<CatalogEntry | null>(null);

function SafeLink({ href, children }: SafeLinkProps) {
  const entry = useContext(MarkdownEntryContext);
  const referencedEntry =
    entry && href ? catalogService.findMarkdownReference(entry, href) : null;
  const resolvedHref = referencedEntry
    ? catalogService.sourceUrl(referencedEntry)
    : href;
  let host = "";

  if (resolvedHref && !referencedEntry) {
    try {
      host = new URL(resolvedHref).hostname.replace(/^www\./, "");
    } catch {
      host = "";
    }
  }

  return (
    <a
      href={resolvedHref}
      target="_blank"
      rel="noopener noreferrer nofollow ugc"
    >
      {children}
      {host ? (
        <span className="ml-1 text-[0.68rem] text-muted-foreground">
          ({host})
        </span>
      ) : null}
    </a>
  );
}

interface SafeCodeProps extends ComponentProps<"code"> {
  children?: ReactNode;
}

/** Turn a contract's path-shaped inline code into a link to its published file. */
function SafeCode({ children, className, ...props }: SafeCodeProps) {
  const entry = useContext(MarkdownEntryContext);
  const reference = typeof children === "string" ? children : "";
  const referencedEntry =
    entry && !className && !reference.includes("\n")
      ? catalogService.findMarkdownReference(entry, reference)
      : null;

  if (!referencedEntry) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }

  return (
    <a
      href={catalogService.sourceUrl(referencedEntry)}
      target="_blank"
      rel="noopener noreferrer nofollow ugc"
    >
      <code {...props}>{referencedEntry.id}.md</code>
    </a>
  );
}

const components: Components = { a: SafeLink, code: SafeCode };

interface MarkdownRendererProps {
  source: string;
  entry: CatalogEntry;
}

export default function MarkdownRenderer({
  source,
  entry,
}: MarkdownRendererProps) {
  return (
    <MarkdownEntryContext value={entry}>
      <div className="prose prose-sm prose-zinc prose-invert max-w-none prose-headings:tracking-tight prose-a:text-indigo-400 prose-code:before:content-none prose-code:after:content-none">
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeSanitize, documentSchema]]}
          components={components}
        >
          {source}
        </Markdown>
      </div>
    </MarkdownEntryContext>
  );
}
