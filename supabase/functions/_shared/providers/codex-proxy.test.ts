import { describe, expect, it } from "vitest";

import {
  chooseGatewayConnection,
  orderGatewayConnections,
  type GatewayConnection,
} from "./codex-proxy";

function connection(
  overrides: Partial<GatewayConnection> & Pick<GatewayConnection, "id">,
): GatewayConnection {
  return {
    created_at: "2026-08-01T00:00:00.000Z",
    last_synced_at: "2026-08-10T00:00:00.000Z",
    display_name: overrides.id,
    planType: "plus",
    metadata: { product: "codex" },
    ...overrides,
  };
}

function limits(
  entries: Record<string, number | { used: number; resetsAt?: string }>,
) {
  const map = new Map<
    string,
    { connection_id: string; used: number | null; resets_at: string | null }[]
  >();

  for (const [id, value] of Object.entries(entries)) {
    const used = typeof value === "number" ? value : value.used;
    const resetsAt =
      typeof value === "number" ? null : (value.resetsAt ?? null);

    map.set(id, [{ connection_id: id, used, resets_at: resetsAt }]);
  }

  return map;
}

describe("Codex gateway account order", () => {
  it("sorts newest last_synced_at first, then newest created_at", () => {
    const oldestSync = connection({
      id: "oldest-sync",
      last_synced_at: "2026-08-10T08:00:00.000Z",
      created_at: "2026-08-20T00:00:00.000Z",
    });
    const newestSync = connection({
      id: "newest-sync",
      last_synced_at: "2026-08-19T12:00:00.000Z",
      created_at: "2026-08-01T00:00:00.000Z",
    });
    const sameSyncOlderConnect = connection({
      id: "same-sync-older",
      last_synced_at: "2026-08-18T12:00:00.000Z",
      created_at: "2026-08-02T00:00:00.000Z",
    });
    const sameSyncNewerConnect = connection({
      id: "same-sync-newer",
      last_synced_at: "2026-08-18T12:00:00.000Z",
      created_at: "2026-08-03T00:00:00.000Z",
    });
    const neverSynced = connection({
      id: "never-synced",
      last_synced_at: null,
      created_at: "2026-08-21T00:00:00.000Z",
    });

    const ordered = orderGatewayConnections([
      neverSynced,
      oldestSync,
      sameSyncOlderConnect,
      newestSync,
      sameSyncNewerConnect,
    ]);

    expect(ordered.map((entry) => entry.id)).toEqual([
      "newest-sync",
      "same-sync-newer",
      "same-sync-older",
      "oldest-sync",
      "never-synced",
    ]);
  });

  it("prefers a newer-synced account still under 95%", () => {
    const newer = connection({
      id: "newer",
      last_synced_at: "2026-08-19T00:00:00.000Z",
    });
    const older = connection({
      id: "older",
      last_synced_at: "2026-08-10T00:00:00.000Z",
    });

    const chosen = chooseGatewayConnection(
      [older, newer],
      limits({ newer: 40, older: 10 }),
    );

    expect(chosen?.id).toBe("newer");
  });

  it("skips a newer-synced account at 95%+ when an older one still has headroom", () => {
    const newerFull = connection({
      id: "newer-full",
      last_synced_at: "2026-08-19T00:00:00.000Z",
    });
    const olderOpen = connection({
      id: "older-open",
      last_synced_at: "2026-08-10T00:00:00.000Z",
    });

    const chosen = chooseGatewayConnection(
      [newerFull, olderOpen],
      limits({ "newer-full": 95, "older-open": 94 }),
    );

    expect(chosen?.id).toBe("older-open");
  });

  it("picks the newest-synced account when every paid account is over 95%", () => {
    const newer = connection({
      id: "newer",
      last_synced_at: "2026-08-19T00:00:00.000Z",
      created_at: "2026-08-01T00:00:00.000Z",
    });
    const older = connection({
      id: "older",
      last_synced_at: "2026-08-10T00:00:00.000Z",
      created_at: "2026-08-20T00:00:00.000Z",
    });

    const chosen = chooseGatewayConnection(
      [older, newer],
      limits({ newer: 99, older: 96 }),
    );

    expect(chosen?.id).toBe("newer");
  });

  it("treats a rolled-over window as headroom even when the stored percent is high", () => {
    const rolledOver = connection({
      id: "rolled-over",
      last_synced_at: "2026-08-19T00:00:00.000Z",
    });
    const live = connection({
      id: "live",
      last_synced_at: "2026-08-10T00:00:00.000Z",
    });

    const chosen = chooseGatewayConnection(
      [live, rolledOver],
      limits({
        "rolled-over": { used: 99, resetsAt: "2020-01-01T00:00:00.000Z" },
        live: 10,
      }),
    );

    expect(chosen?.id).toBe("rolled-over");
  });

  it("returns null when the pool is empty", () => {
    expect(chooseGatewayConnection([], new Map())).toBeNull();
  });
});
