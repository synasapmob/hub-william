import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ProviderIcon from "./provider-icon";

describe("ProviderIcon", () => {
  it("shows the first letter for an agent Hub William has no icon for", () => {
    render(<ProviderIcon provider="Perplexity" />);

    expect(screen.getByText("P")).toBeVisible();
  });

  it("shows the first letter of the label when it is given, until the icon loads", () => {
    render(<ProviderIcon label="ChatGPT" provider="chatgpt" />);

    // Nothing is fetched in a test, so the image never loads and the letter shows.
    expect(screen.getByText("C")).toBeVisible();
  });
});
