import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadBlob } from "@/utils/utils.download";

import ToolsCatalogDownloadReel from "./tools-catalog-download-reel";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/utils/utils.download", () => ({ downloadBlob: vi.fn() }));

function stubFetch(response: Response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

async function fetchPreview() {
  const user = userEvent.setup();
  const view = render(<ToolsCatalogDownloadReel />);

  await user.type(
    screen.getByPlaceholderText(/Paste/),
    "https://x.com/jack/status/20",
  );
  await user.click(screen.getByRole("button", { name: /Fetch & Preview/ }));

  return view;
}

describe("ToolsCatalogDownloadReel errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(toast.error).mockClear();
    vi.mocked(downloadBlob).mockClear();
  });

  it("toasts the HTTP status when the gateway answers with an empty body", async () => {
    stubFetch(new Response("", { status: 404 }));
    await fetchPreview();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Failed to fetch video information (HTTP 404).",
      ),
    );
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();
  });

  it("toasts the API message, such as a rate limit", async () => {
    stubFetch(
      Response.json(
        { code: "rate_limited", message: "Too many requests." },
        { status: 429 },
      ),
    );
    await fetchPreview();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Too many requests."),
    );
  });

  it("toasts when the preview video cannot be played", async () => {
    stubFetch(
      Response.json({
        id: "20",
        platform: "x",
        videoUrl: "https://video.twimg.com/a.mp4",
      }),
    );
    const { container } = await fetchPreview();

    const video = await waitFor(() => {
      const element = container.querySelector("video");
      if (!element) throw new Error("preview not rendered yet");

      return element;
    });
    fireEvent.error(video);

    expect(toast.error).toHaveBeenCalledWith(
      "The preview could not be played. Try again in a moment.",
    );
  });

  describe("downloading", () => {
    // A Response body can be read once, so each request gets a fresh one.
    const resolved = () =>
      Response.json({
        id: "20",
        platform: "x",
        videoUrl: "https://video.twimg.com/a.mp4",
      });

    async function openPreview(download: Response) {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) =>
          Promise.resolve(
            String(input).includes("/reel/download") ? download : resolved(),
          ),
        ),
      );
      await fetchPreview();

      return screen.findByRole("button", { name: "Download Video" });
    }

    it("saves the fetched bytes under the platform and id", async () => {
      const button = await openPreview(new Response("mp4-bytes"));
      await userEvent.click(button);

      await waitFor(() =>
        expect(downloadBlob).toHaveBeenCalledWith("x-20.mp4", expect.any(Blob)),
      );
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("toasts the API message and saves nothing when the download is limited", async () => {
      const button = await openPreview(
        Response.json({ message: "Too many requests." }, { status: 429 }),
      );
      await userEvent.click(button);

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Too many requests."),
      );
      expect(downloadBlob).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: "Download Video" }),
      ).toBeEnabled();
    });

    it("toasts the HTTP status when the error body is empty", async () => {
      const button = await openPreview(new Response("", { status: 502 }));
      await userEvent.click(button);

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "Failed to download the video (HTTP 502).",
        ),
      );
    });
  });
});
