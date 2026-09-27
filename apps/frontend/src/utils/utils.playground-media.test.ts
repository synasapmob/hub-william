import { afterEach, describe, expect, it, vi } from "vitest";
import playgroundMedia from "./utils.playground-media";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("saved call media choices", () => {
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
    expect(playgroundMedia.read()).toEqual({ voice: true, camera: true });
    expect(() =>
      playgroundMedia.write({ voice: false, camera: false }),
    ).not.toThrow();
  });
});
