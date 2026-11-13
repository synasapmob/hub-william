import { ServiceError } from "@/services/api/api-client";
import type {
  IconAssignment,
  LibraryIcon,
  ProviderIcons,
} from "@/services/icons/icon-service";

const url = (key: string) => `https://cdn.example.com/${key}`;

const icon = (key: string): LibraryIcon => ({
  key,
  size: 1024,
  url: url(key),
  used_by: [],
});

// What the bucket holds at the start of a test, and what two providers show.
const LIBRARY = ["icons/chatgpt-ba7816bf.png", "icons/claude-0f1e2d3c.png"];

let enabled = true;
let library: LibraryIcon[] = [];
let assignments: IconAssignment[] = [];
// A reason to refuse the next call of each kind with, then nothing.
let refusal: {
  upload?: string;
  assign?: string;
  library?: string;
  remove?: string;
} = {};

export function resetFakeIcons() {
  enabled = true;
  library = LIBRARY.map(icon);
  assignments = [
    {
      key: LIBRARY[0],
      provider: "chatgpt",
      url: url(LIBRARY[0]),
    },
  ];
  refusal = {};
}

/** A bucket that is not set up: nothing is shown and nothing can be chosen. */
export function disableFakeIcons() {
  enabled = false;
  assignments = [];
}

/** Makes the next call of this kind fail with this reason. */
export function refuseNextFakeIcon(call: keyof typeof refusal, reason: string) {
  refusal[call] = reason;
}

export function fakeIconAssignments() {
  return assignments;
}

function refuse(call: keyof typeof refusal) {
  const reason = refusal[call];

  if (!reason) return;

  delete refusal[call];

  throw new ServiceError(reason, 422, "validation_error");
}

export const fakeIconService = {
  libraryKey: ["dashboard", "icons", "library"] as const,
  queryKey: ["dashboard", "icons"] as const,

  async list(): Promise<ProviderIcons> {
    return structuredClone({ assignments, enabled });
  },

  async library(): Promise<LibraryIcon[]> {
    refuse("library");

    // Who shows an icon is read from the assignments, as the API reads it.
    return structuredClone(
      library.map((entry) => ({
        ...entry,
        used_by: assignments
          .filter((assignment) => assignment.key === entry.key)
          .map(({ provider }) => ({ name: null, provider })),
      })),
    );
  },

  async remove(key: string): Promise<string[]> {
    refuse("remove");
    const cleared = assignments
      .filter((assignment) => assignment.key === key)
      .map(({ provider }) => provider);

    library = library.filter((entry) => entry.key !== key);
    assignments = assignments.filter((assignment) => assignment.key !== key);

    return cleared;
  },

  async upload(file: File, name: string): Promise<string> {
    refuse("upload");
    const key = `icons/${name.toLowerCase()}-${file.size.toString(16).padStart(8, "0")}.png`;

    library = [...library.filter((entry) => entry.key !== key), icon(key)];

    return key;
  },

  async assign(provider: string, key: string | null): Promise<void> {
    refuse("assign");
    assignments = assignments.filter((entry) => entry.provider !== provider);

    if (key) assignments.push({ key, provider, url: url(key) });
  },
};

resetFakeIcons();
