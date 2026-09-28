import { afterEach, describe, expect, it, vi } from "vitest";
import playgroundMedia from "./utils.playground-media";
import { playgroundModes } from "@/services/provider-catalogue";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("saved call media choices", () => {
  it.each(playgroundModes)("restores the saved %s mode", (mode) => {
    playgroundMedia.writeMode(mode);
    expect(playgroundMedia.readMode()).toBe(mode);
  });
  it("defaults to Chat for absent or invalid modes and preserves legacy Call for account-aware migration", () => {
    expect(playgroundMedia.readMode()).toBe("chat");
    window.localStorage.setItem("hub.playground.mode", "unknown");
    expect(playgroundMedia.readMode()).toBe("chat");
    window.localStorage.setItem("hub.playground.mode", "voice");
    expect(playgroundMedia.readMode()).toBe("voice");
  });
  it("round trips explicit false values and falls back safely for corrupt preferences", () => {
    playgroundMedia.write({ voice: false, camera: true });
    expect(playgroundMedia.read()).toEqual({ voice: false, camera: true });
    window.localStorage.setItem(
      "hub.playground.media",
      '{"voice":"false","camera":false}',
    );
    expect(playgroundMedia.read()).toEqual({ voice: true, camera: true });
    window.localStorage.setItem("hub.playground.media", "broken");
    expect(playgroundMedia.read()).toEqual({ voice: true, camera: true });
  });
  it("keeps controls usable when browser storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(playgroundMedia.readMode()).toBe("chat");
    expect(() => playgroundMedia.writeMode("call-whisper")).not.toThrow();
    expect(playgroundMedia.read()).toEqual({ voice: true, camera: true });
    expect(() =>
      playgroundMedia.write({ voice: false, camera: false }),
    ).not.toThrow();
  });
});
