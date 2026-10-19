import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import voskService, {
  type VoskRecording,
  type VoskTranscribeOptions,
} from "@/services/vosk";

import ToolsCatalogVosk from "./tools-catalog-vosk";

function renderVosk() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ToolsCatalogVosk />
    </QueryClientProvider>,
  );
}

async function pickFile(name = "interview.mp3") {
  await userEvent.click(screen.getByRole("tab", { name: /import/i }));

  return userEvent.upload(
    screen.getByLabelText("Audio file"),
    new File([new Uint8Array([1, 2])], name, { type: "audio/mpeg" }),
  );
}

describe("ToolsCatalogVosk", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts on Voice and keeps Transcribe disabled until there is audio", async () => {
    renderVosk();

    expect(screen.getByRole("tab", { name: /voice/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Start recording" }),
    ).toBeVisible();

    expect(screen.getByRole("button", { name: "Transcribe" })).toBeDisabled();

    await pickFile();

    expect(screen.getByRole("button", { name: "Transcribe" })).toBeEnabled();
  });

  it("transcribes with the selected language and shows the transcript", async () => {
    const user = userEvent.setup();
    const transcribe = vi
      .spyOn(voskService, "transcribe")
      .mockResolvedValue("hello from the recording");
    renderVosk();

    await user.selectOptions(screen.getByLabelText("Language"), "vi");
    await pickFile();
    await user.click(screen.getByRole("button", { name: "Transcribe" }));

    expect(await screen.findByLabelText("Transcript text")).toHaveValue(
      "hello from the recording",
    );
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ id: "vi" }),
        file: expect.objectContaining({ name: "interview.mp3" }),
      }),
    );
    expect(screen.getByRole("button", { name: /Copy/ })).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Download \.txt/ }),
    ).toBeVisible();
  });

  it("reports progress while the file is processed", async () => {
    const user = userEvent.setup();
    let finish: (text: string) => void = () => {};
    vi.spyOn(voskService, "transcribe").mockImplementation(
      ({ onProgress }: VoskTranscribeOptions) =>
        new Promise<string>((resolve) => {
          onProgress?.({ phase: "recognizing", fraction: 0.5, text: "so far" });
          finish = resolve;
        }),
    );
    renderVosk();

    await pickFile();
    await user.click(screen.getByRole("button", { name: "Transcribe" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Transcribing… 50%",
    );
    expect(screen.getByLabelText("Transcript text")).toHaveValue("so far");
    expect(screen.getByLabelText("Language")).toBeDisabled();
    expect(screen.getByLabelText("Audio file")).toBeDisabled();

    finish("so far and done");

    await waitFor(() =>
      expect(screen.getByLabelText("Transcript text")).toHaveValue(
        "so far and done",
      ),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("explains an empty transcript", async () => {
    const user = userEvent.setup();
    vi.spyOn(voskService, "transcribe").mockResolvedValue("");
    renderVosk();

    await pickFile();
    await user.click(screen.getByRole("button", { name: "Transcribe" }));

    expect(await screen.findByText(/No speech was detected/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Copy/ })).toBeNull();
  });

  it("shows the failure and lets the reader pick another file", async () => {
    const user = userEvent.setup();
    vi.spyOn(voskService, "transcribe").mockRejectedValue(
      new Error("This file could not be decoded as audio."),
    );
    renderVosk();

    await pickFile("notes.txt");
    await user.click(screen.getByRole("button", { name: "Transcribe" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This file could not be decoded as audio.",
    );

    await pickFile("good.wav");

    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("voice input", () => {
    function fakeSession() {
      let finish: (file: File) => void = () => {};
      let fail: (error: Error) => void = () => {};
      const session: VoskRecording = {
        result: new Promise<File>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
        stop: vi.fn(() =>
          finish(new File([new Uint8Array([1])], "recording.webm")),
        ),
        cancel: vi.fn(() => fail(new Error("Recording cancelled."))),
      };

      return session;
    }

    it("records, then transcribes the recording", async () => {
      const user = userEvent.setup();
      const session = fakeSession();
      vi.spyOn(voskService, "record").mockResolvedValue(session);
      const transcribe = vi
        .spyOn(voskService, "transcribe")
        .mockResolvedValue("spoken words");
      renderVosk();

      await user.click(screen.getByRole("button", { name: "Start recording" }));
      await user.click(
        await screen.findByRole("button", { name: /Stop recording/ }),
      );

      expect(await screen.findByText(/Recording ready/)).toBeVisible();

      await user.click(screen.getByRole("button", { name: "Transcribe" }));

      expect(await screen.findByLabelText("Transcript text")).toHaveValue(
        "spoken words",
      );
      expect(transcribe).toHaveBeenCalledWith(
        expect.objectContaining({
          file: expect.objectContaining({ name: "recording.webm" }),
        }),
      );
      expect(
        screen.getByRole("button", { name: "Record again" }),
      ).toBeVisible();
    });

    it("shows why the microphone could not start", async () => {
      const user = userEvent.setup();
      vi.spyOn(voskService, "record").mockRejectedValue(
        new Error("Microphone access was blocked."),
      );
      renderVosk();

      await user.click(screen.getByRole("button", { name: "Start recording" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Microphone access was blocked.",
      );
      expect(screen.getByRole("button", { name: "Transcribe" })).toBeDisabled();
    });

    it("releases the microphone when the reader leaves Voice", async () => {
      const user = userEvent.setup();
      const session = fakeSession();
      vi.spyOn(voskService, "record").mockResolvedValue(session);
      renderVosk();

      await user.click(screen.getByRole("button", { name: "Start recording" }));
      await screen.findByRole("button", { name: /Stop recording/ });
      await user.click(screen.getByRole("tab", { name: /import/i }));

      expect(session.cancel).toHaveBeenCalledOnce();
    });

    it("keeps imported and recorded audio separate", async () => {
      const user = userEvent.setup();
      const session = fakeSession();
      vi.spyOn(voskService, "record").mockResolvedValue(session);
      renderVosk();

      await user.click(screen.getByRole("button", { name: "Start recording" }));
      await user.click(
        await screen.findByRole("button", { name: /Stop recording/ }),
      );
      await screen.findByText(/Recording ready/);

      await user.click(screen.getByRole("tab", { name: /import/i }));
      expect(screen.getByRole("button", { name: "Transcribe" })).toBeDisabled();

      await user.click(screen.getByRole("tab", { name: /voice/i }));
      expect(screen.getByRole("button", { name: "Transcribe" })).toBeEnabled();
    });
  });
});
