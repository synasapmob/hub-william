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

function pickFile(name = "interview.mp3") {
  return userEvent.upload(
    screen.getByLabelText("Audio file"),
    new File([new Uint8Array([1, 2])], name, { type: "audio/mpeg" }),
  );
}

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

const transcribeButton = () =>
  screen.getByRole("button", { name: "Transcribe" });

describe("ToolsCatalogVosk", () => {
  afterEach(() => vi.restoreAllMocks());

  it("offers Start voice and Import, and Transcribe waits for audio", () => {
    renderVosk();

    expect(screen.getByRole("button", { name: "Start voice" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Import" })).toBeVisible();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(transcribeButton()).toBeDisabled();
  });

  it("opens the file picker straight from Import", async () => {
    const user = userEvent.setup();
    renderVosk();
    const picker = vi
      .spyOn(screen.getByLabelText("Audio file"), "click")
      .mockImplementation(() => {});

    await user.click(screen.getByRole("button", { name: "Import" }));

    expect(picker).toHaveBeenCalledOnce();
  });

  it("transcribes an imported file with the selected language", async () => {
    const user = userEvent.setup();
    const transcribe = vi
      .spyOn(voskService, "transcribe")
      .mockResolvedValue("hello from the recording");
    renderVosk();

    await user.selectOptions(screen.getByLabelText("Language"), "vi");
    await pickFile();

    expect(
      screen.getByText(/Ready to transcribe: interview\.mp3/),
    ).toBeVisible();

    await user.click(transcribeButton());

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

  it("toggles Start voice into Stop voice, then transcribes the recording", async () => {
    const user = userEvent.setup();
    vi.spyOn(voskService, "record").mockResolvedValue(fakeSession());
    const transcribe = vi
      .spyOn(voskService, "transcribe")
      .mockResolvedValue("spoken words");
    renderVosk();

    await user.click(screen.getByRole("button", { name: "Start voice" }));

    const stop = await screen.findByRole("button", { name: /Stop voice/ });
    expect(screen.queryByRole("button", { name: "Start voice" })).toBeNull();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    expect(transcribeButton()).toBeDisabled();

    await user.click(stop);

    expect(
      await screen.findByText(/Ready to transcribe: recording\.webm/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Start voice" })).toBeVisible();

    await user.click(transcribeButton());

    expect(await screen.findByLabelText("Transcript text")).toHaveValue(
      "spoken words",
    );
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        file: expect.objectContaining({ name: "recording.webm" }),
      }),
    );
  });

  it("lets an import replace a recording and a recording replace an import", async () => {
    const user = userEvent.setup();
    vi.spyOn(voskService, "record").mockImplementation(() =>
      Promise.resolve(fakeSession()),
    );
    renderVosk();

    await user.click(screen.getByRole("button", { name: "Start voice" }));
    await user.click(await screen.findByRole("button", { name: /Stop voice/ }));
    await screen.findByText(/recording\.webm/);

    await pickFile("notes.mp3");
    expect(screen.getByText(/Ready to transcribe: notes\.mp3/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Start voice" }));
    await user.click(await screen.findByRole("button", { name: /Stop voice/ }));
    expect(
      await screen.findByText(/Ready to transcribe: recording\.webm/),
    ).toBeVisible();
  });

  it("shows why the microphone could not start", async () => {
    const user = userEvent.setup();
    vi.spyOn(voskService, "record").mockRejectedValue(
      new Error("Microphone access was blocked."),
    );
    renderVosk();

    await user.click(screen.getByRole("button", { name: "Start voice" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Microphone access was blocked.",
    );
    expect(screen.getByRole("button", { name: "Start voice" })).toBeEnabled();
    expect(transcribeButton()).toBeDisabled();
  });

  it("releases the microphone when the tool closes mid-recording", async () => {
    const user = userEvent.setup();
    const session = fakeSession();
    vi.spyOn(voskService, "record").mockResolvedValue(session);
    const { unmount } = renderVosk();

    await user.click(screen.getByRole("button", { name: "Start voice" }));
    await screen.findByRole("button", { name: /Stop voice/ });
    unmount();

    expect(session.cancel).toHaveBeenCalledOnce();
  });

  it("reports progress while the audio is processed", async () => {
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
    await user.click(transcribeButton());

    expect(await screen.findByText("Transcribing… 50%")).toBeVisible();
    expect(screen.getByLabelText("Transcript text")).toHaveValue("so far");
    expect(screen.getByLabelText("Language")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start voice" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();

    finish("so far and done");

    await waitFor(() =>
      expect(screen.getByLabelText("Transcript text")).toHaveValue(
        "so far and done",
      ),
    );
    expect(screen.queryByText(/Transcribing… \d+%/)).toBeNull();
  });

  it("explains an empty transcript", async () => {
    const user = userEvent.setup();
    vi.spyOn(voskService, "transcribe").mockResolvedValue("");
    renderVosk();

    await pickFile();
    await user.click(transcribeButton());

    expect(await screen.findByText(/No speech was detected/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Copy/ })).toBeNull();
  });

  it("shows the failure and clears it when another file is picked", async () => {
    const user = userEvent.setup();
    vi.spyOn(voskService, "transcribe").mockRejectedValue(
      new Error("This file could not be decoded as audio."),
    );
    renderVosk();

    await pickFile("notes.txt");
    await user.click(transcribeButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This file could not be decoded as audio.",
    );

    await pickFile("good.wav");

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
