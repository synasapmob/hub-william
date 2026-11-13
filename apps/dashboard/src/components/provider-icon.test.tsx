import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ProviderIcon from "./provider-icon";
import {
  ProviderIconsContext,
  type ProviderIconsValue,
} from "./provider-icons-context";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The shop's icons, as the dashboard shell hands them down. */
function renderWithIcons(icons: Record<string, string>, ui: React.ReactNode) {
  const value: ProviderIconsValue = {
    enabled: true,
    iconOf: (provider) => {
      const url = icons[provider.trim().toLowerCase()];

      return url ? { key: "icons/x.png", provider, url } : null;
    },
  };

  return render(
    <ProviderIconsContext value={value}>{ui}</ProviderIconsContext>,
  );
}

// A picture that loads at once. jsdom never loads one, so the avatar would only ever
// show its letter, which is what a test of the picture must not settle for.
function stubLoadingImages() {
  vi.stubGlobal(
    "Image",
    class {
      // What the avatar reads to tell a picture that loaded from one that did not.
      complete = false;

      naturalWidth = 0;

      private loaded = new Set<(event: { currentTarget: unknown }) => void>();

      addEventListener(
        type: string,
        listener: (event: { currentTarget: unknown }) => void,
      ) {
        if (type === "load") this.loaded.add(listener);
      }

      removeEventListener(
        type: string,
        listener: (event: { currentTarget: unknown }) => void,
      ) {
        if (type === "load") this.loaded.delete(listener);
      }

      set src(_value: string) {
        queueMicrotask(() => {
          this.complete = true;
          this.naturalWidth = 1;
          this.loaded.forEach((listener) => listener({ currentTarget: this }));
        });
      }
    },
  );
}

describe("ProviderIcon", () => {
  it("shows an empty frame, and no letter, for a provider with no icon", () => {
    const { container } = render(<ProviderIcon provider="Perplexity" />);

    expect(screen.queryByText("P")).not.toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("shows the empty frame, and no letter, until the picture loads", () => {
    const { container } = renderWithIcons(
      { chatgpt: "https://cdn.example.com/icons/chatgpt-1.webp" },
      <ProviderIcon provider="ChatGPT" />,
    );

    // Nothing is fetched in a test, so the image never loads.
    expect(screen.queryByText("C")).not.toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("shows the picture the shop chose once it has loaded, from where the bucket is public", async () => {
    stubLoadingImages();
    const { container } = renderWithIcons(
      { claude: "https://cdn.example.com/icons/claude-1.png" },
      <ProviderIcon provider="Claude" />,
    );

    await waitFor(() =>
      expect(container.querySelector("img")).toHaveAttribute(
        "src",
        "https://cdn.example.com/icons/claude-1.png",
      ),
    );
  });

  it("finds the picture of a provider however its name is written", async () => {
    stubLoadingImages();
    const { container } = renderWithIcons(
      { claude: "https://cdn.example.com/icons/claude-1.png" },
      <ProviderIcon provider=" CLAUDE " />,
    );

    await waitFor(() =>
      expect(container.querySelector("img")).toBeInTheDocument(),
    );
  });

  it("shows no picture for a provider the shop gave none, though others have one", async () => {
    stubLoadingImages();
    const { container } = renderWithIcons(
      { claude: "https://cdn.example.com/icons/claude-1.png" },
      <ProviderIcon provider="Perplexity" />,
    );

    // Let a picture show up if one were going to.
    await Promise.resolve();

    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(screen.queryByText("P")).not.toBeInTheDocument();
  });
});
