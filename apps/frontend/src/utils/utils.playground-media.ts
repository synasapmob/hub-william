export interface PlaygroundMediaPreferences {
  voice: boolean;
  camera: boolean;
}

const key = "hub.playground.media";
const modeKey = "hub.playground.mode";
const defaults: PlaygroundMediaPreferences = { voice: true, camera: true };

function readMode(): "chat" | "voice" {
  try {
    return window.localStorage.getItem(modeKey) === "voice" ? "voice" : "chat";
  } catch {
    return "chat";
  }
}

function writeMode(mode: "chat" | "voice") {
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
