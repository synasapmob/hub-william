import {
  playgroundModes,
  type PlaygroundMode,
} from "@/services/provider-catalogue";

// Legacy Call is resolved after the workspace's accessible accounts load.
export type SavedPlaygroundMode = PlaygroundMode | "voice";

export interface PlaygroundMediaPreferences {
  voice: boolean;
  camera: boolean;
}

const key = "hub.playground.media";
const modeKey = "hub.playground.mode";
const defaults: PlaygroundMediaPreferences = { voice: true, camera: true };

function readMode(): SavedPlaygroundMode {
  try {
    const value = window.localStorage.getItem(modeKey);
    return value === "voice"
      ? value
      : (playgroundModes.find((mode) => mode === value) ?? "chat");
  } catch {
    return "chat";
  }
}

function writeMode(mode: PlaygroundMode) {
  try {
    window.localStorage.setItem(modeKey, mode);
  } catch {
    // Mode selection remains usable when browser storage is unavailable.
  }
}

function read(): PlaygroundMediaPreferences {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(key) ?? "null",
    );
    if (
      value &&
      typeof value === "object" &&
      "voice" in value &&
      typeof value.voice === "boolean" &&
      "camera" in value &&
      typeof value.camera === "boolean"
    )
      return { voice: value.voice, camera: value.camera };
  } catch {
    // Browser storage may be unavailable. Media controls still work in memory.
  }
  return { ...defaults };
}

function write(preferences: PlaygroundMediaPreferences) {
  try {
    window.localStorage.setItem(key, JSON.stringify(preferences));
  } catch {
    // Retain the current in-memory choice when storage is blocked or full.
  }
}

export default { read, write, readMode, writeMode };
