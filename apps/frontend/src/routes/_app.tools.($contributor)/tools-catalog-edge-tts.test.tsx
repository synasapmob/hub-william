import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import ToolsCatalogEdgeTts from "./tools-catalog-edge-tts";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

describe("ToolsCatalogEdgeTts errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(toast.error).mockClear();
  });

  it("toasts the API message instead of rendering a banner", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { code: "rate_limited", message: "Too many requests." },
            { status: 429 },
          ),
        ),
    );
    render(<ToolsCatalogEdgeTts />);

    await user.click(screen.getByRole("button", { name: /Generate & Play/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Too many requests."),
    );
    expect(screen.queryByText("Too many requests.")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Generate & Play/ }),
    ).toBeEnabled();
  });

  it("toasts the status when the server answers without a JSON message", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("", { status: 502, statusText: "Bad Gateway" }),
        ),
    );
    render(<ToolsCatalogEdgeTts />);

    await user.click(screen.getByRole("button", { name: /Generate & Play/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Lỗi máy chủ (502 Bad Gateway)"),
    );
  });
});
