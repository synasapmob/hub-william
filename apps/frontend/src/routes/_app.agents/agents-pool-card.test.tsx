import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentPool } from "@/services/agent-pools";

import AgentsPoolCard from "./agents-pool-card";

const VERIFY_URL = "https://accounts.google.com/signin/continue?sarp=1";

function pool(validationUrl?: string): AgentPool {
  return {
    accountLabel: "ui-account-A",
    agent: "Gemini",
    availability: { status: "reauth_required", validationUrl },
    capacity: 1,
    createdAt: "2026-10-15T00:00:00Z",
    id: "pool-a",
    members: [],
    owner: {
      avatarLabel: "ui",
      joinedAt: "2026-10-15T00:00:00Z",
      share: {
        availablePercent: 100,
        memberCount: 0,
        poolCachedTokens: 0,
        poolInputTokens: 0,
        poolOutputTokens: 0,
        poolUnits: 0,
        userCachedTokens: 0,
        userInputTokens: 0,
        userOutputTokens: 0,
        userUnits: 0,
      },
      usageAvailablePercent: 100,
      username: "ui-owner",
    },
    plan: "Antigravity",
    requests: [],
    usage: [],
  };
}

function renderCard(
  validationUrl?: string,
  status: AgentPool["availability"]["status"] = "reauth_required",
) {
  return render(
    <AgentsPoolCard
      currentUsername="ui-owner"
      onCheckRequests={vi.fn()}
      onClose={vi.fn()}
      onRequestJoin={vi.fn()}
      pool={{ ...pool(validationUrl), availability: { status, validationUrl } }}
    />,
  );
}

describe("AgentsPoolCard", () => {
  it("links the provider's account verification when it asked for one", () => {
    renderCard(VERIFY_URL);

    expect(
      screen.getByText("Verify this account with Google"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Verify with Google/ }),
    ).toHaveAttribute("href", VERIFY_URL);
  });

  it("shows no verification link for a reconnect without one", () => {
    renderCard();

    expect(
      screen.queryByRole("link", { name: /Verify with Google/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps a usable account free of the verification offer", () => {
    renderCard(VERIFY_URL, "active");

    expect(
      screen.queryByRole("link", { name: /Verify with Google/ }),
    ).not.toBeInTheDocument();
  });
});
