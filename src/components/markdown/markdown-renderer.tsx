import type { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

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

function SafeLink({ href, children }: SafeLinkProps) {
  let host = "";

  if (href) {
    try {
      host = new URL(href).hostname.replace(/^www\./, "");
    } catch {
      host = "";
    }
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc">
      {children}
      {host ? (
        <span className="ml-1 text-[0.68rem] text-muted-foreground">
          ({host})
        </span>
      ) : null}
    </a>
  );
}

const components: Components = { a: SafeLink };

interface MarkdownRendererProps {
  source: string;
}

export default function MarkdownRenderer({ source }: MarkdownRendererProps) {
  return (
    <div className="prose prose-sm prose-zinc max-w-none prose-headings:tracking-tight prose-a:text-indigo-600 prose-code:before:content-none prose-code:after:content-none">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, documentSchema]]}
        components={components}
      >
        {source}
      </Markdown>
    </div>
  );
}
