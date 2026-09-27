import { createRef } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceShellSessionContext from "@/components/workspace-shell/workspace-shell-session-context";
import createQueryClient from "@/utils/utils.query-client";
import playgroundRecorderService from "@/services/playground/playground-recorder";
import playgroundRecordingsService, {
  type PlaygroundRecordingFile,
} from "@/services/playground/playground-recordings";
import PlaygroundVoiceRecordings from "./playground-voice-recordings";

vi.mock("@/services/playground/playground-recorder", () => ({
  default: { start: vi.fn() },
}));
vi.mock("@/services/playground/playground-recordings", () => ({
  default: {
    queryKey: ["local-call-recordings"],
    list: vi.fn(),
    save: vi.fn(),
    load: vi.fn(),
    remove: vi.fn(),
  },
}));
const file: PlaygroundRecordingFile = {
  id: "recorded",
  ownerId: "user-a",
  createdAt: 1000,
  duration: 3200,
  model: "whisper-large-v3-turbo",
  mimeType: "video/webm",
  blob: new Blob(["media"], { type: "video/webm" }),
  transcripts: [
    { id: 0, role: "user", text: "Hello teacher", complete: true },
    { id: 1, role: "assistant", text: "Hi there", complete: true },
    { id: 2, role: "user", text: "Lượt mới của tôi", complete: true },
    { id: 3, role: "assistant", text: "New reply", complete: true },
  ],
};
let saved: PlaygroundRecordingFile[];
let complete: (value: PlaygroundRecordingFile) => void;
const stop = vi.fn();
const stopRef = createRef<(() => void) | null>();
const camera = createRef<HTMLVideoElement | null>();

function mount() {
  const queryClient = createQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceShellSessionContext.Provider
        value={{
          user: { id: "user-a", username: "owner", recoveryEmail: null },
          status: "authenticated",
          openAuth: vi.fn(),
          signOut: vi.fn(),
        }}
      >
        <PlaygroundVoiceRecordings
          connected
          camera={camera}
          sources={{ microphone: {} as MediaStream, bot: null }}
          transcripts={[]}
          model={file.model}
          stopRef={stopRef}
        />
      </WorkspaceShellSessionContext.Provider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("MediaRecorder", class {});
  vi.stubGlobal("indexedDB", {});
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn((blob: Blob) =>
      blob.type.startsWith("text/plain") ? "blob:transcript" : "blob:recording",
    ),
    revokeObjectURL: vi.fn(),
  });
  camera.current = document.createElement("video");
  saved = [];
  vi.mocked(playgroundRecordingsService.list).mockImplementation(
    async (owner) => saved.filter((entry) => entry.ownerId === owner),
  );
  vi.mocked(playgroundRecordingsService.save).mockImplementation(
    async (entry) => {
      saved.push(entry);
    },
  );
  vi.mocked(playgroundRecordingsService.load).mockResolvedValue(file);
  vi.mocked(playgroundRecordingsService.remove).mockImplementation(async () => {
    saved = [];
  });
  stop.mockImplementation(() => complete(file));
  vi.mocked(playgroundRecorderService.start).mockImplementation(async () => ({
    stop,
    sources: vi.fn(),
    transcripts: vi.fn(),
    result: new Promise((resolve) => {
      complete = resolve;
    }),
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Local call recordings", () => {
  it("finalizes through the call cleanup hook, saves with the session owner, and reopens playback with transcript/download", async () => {
    const user = userEvent.setup();
    const first = mount();
    await user.click(screen.getByRole("button", { name: "Record" }));
    await screen.findByRole("button", { name: "Stop record" });
    act(() => stopRef.current?.());
    await screen.findByRole("button", { name: "Recordings (1)" });
    expect(playgroundRecordingsService.save).toHaveBeenCalledWith(file);
    first.unmount();
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Recordings (1)" }),
    );
    await user.click(screen.getByRole("menuitem"));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getByText("Lượt mới của tôi")).toBeVisible(),
    );
    expect(within(dialog).getByText("New reply")).toBeVisible();
    expect(within(dialog).queryByText("Hello teacher")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Hi there")).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole("article")).toHaveLength(2);
    expect(
      within(dialog).getByRole("heading", {
        name: `Call recording ${new Date(file.createdAt).toLocaleString()}`,
      }),
    ).toBeVisible();
    const transcriptHeading = within(dialog).getByRole("heading", {
      name: "Transcript",
    });
    expect(
      within(transcriptHeading.parentElement!).getByText("3s"),
    ).toBeVisible();
    expect(
      within(transcriptHeading.parentElement!).getByText(file.model),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("link", { name: "Download Video" }),
    ).toHaveAttribute("download", "hub-call-1000.webm");
    expect(URL.createObjectURL).toHaveBeenCalledWith(file.blob);
    expect(
      within(dialog).getByRole("link", { name: "Download Transcript" }),
    ).toHaveAttribute("download", "hub-call-1000.txt");
    expect(
      within(dialog).getByRole("link", { name: "Download Transcript" }),
    ).toHaveAttribute("href", "blob:transcript");
    const textBlob = vi
      .mocked(URL.createObjectURL)
      .mock.calls.map(([blob]) => blob as Blob)
      .find((blob) => blob.type.startsWith("text/plain"))!;
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(textBlob);
    });
    expect(text).toBe(
      "YOU\nHello teacher\n\nBOT\nHi there\n\nYOU\nLượt mới của tôi\n\nBOT\nNew reply",
    );
    expect(playgroundRecordingsService.load).toHaveBeenCalledWith(
      "user-a",
      "recorded",
    );
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:recording");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:transcript");
  });

  it("keeps a download available when local storage is full and never claims the clip was saved", async () => {
    vi.mocked(playgroundRecordingsService.save).mockRejectedValue(
      new DOMException("Full", "QuotaExceededError"),
    );
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Record" }));
    await user.click(
      await screen.findByRole("button", { name: "Stop record" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("link", { name: "Download Video" }),
    ).toHaveAttribute("href", "blob:recording");
    expect(
      screen.getByText(/Could not save on this device/),
    ).toBeInTheDocument();
    expect(saved).toEqual([]);
    const unloading = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unloading);
    expect(unloading.defaultPrevented).toBe(true);
    await user.click(
      within(dialog).getByRole("button", { name: "Delete Record" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Recordings (0)" }),
    ).toBeVisible();
  });
});
