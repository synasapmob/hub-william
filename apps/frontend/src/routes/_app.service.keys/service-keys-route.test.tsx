import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkspaceShellSession from "@/components/workspace-shell/workspace-shell-session";
import { authService } from "@/services/auth/auth-service";
import { serviceBillingService } from "@/services/service-billing/service-billing-service";
import type { ServicePricing } from "@/services/service-billing/service-billing-types";
import {
  ServiceKeyTestError,
  serviceKeyTestService,
} from "@/services/service-key-test/service-key-test-service";
import { serviceKeysService } from "@/services/service-keys/service-keys-service";
import type {
  CreatedServiceKey,
  ServiceKey,
} from "@/services/service-keys/service-keys-types";
import { copyText } from "@/utils/utils.clipboard";
import createQueryClient from "@/utils/utils.query-client";

import ServiceKeysRoute from "./route";

vi.mock("@/utils/utils.clipboard", () => ({ copyText: vi.fn() }));

const older: ServiceKey = {
  createdAt: "2026-11-01T03:00:00Z",
  id: "11111111-1111-4111-8111-111111111111",
  lastFour: "xB_E",
  lastUsedAt: "2026-11-05T03:00:00Z",
};

const fresh: CreatedServiceKey = {
  createdAt: "2026-11-06T03:00:00Z",
  id: "22222222-2222-4222-8222-222222222222",
  key: "hw_svc_fake-key-for-a-test-0123456789",
  lastFour: "6789",
  lastUsedAt: null,
};

function renderRoute(client = createQueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceShellSession>
        <MemoryRouter initialEntries={["/service/keys"]}>
          <Routes>
            <Route path="/service/keys" element={<ServiceKeysRoute />} />

            <Route path="/service/pricing" element={<p>Pricing page</p>} />
          </Routes>
        </MemoryRouter>
      </WorkspaceShellSession>
    </QueryClientProvider>,
  );
}

const price = {
  cachedMicroPerMillion: 60_000,
  inputMicroPerMillion: 600_000,
  outputMicroPerMillion: 4_700_000,
};

// Two agents the platform can serve, one it cannot.
const offer: ServicePricing = {
  currency: "USD",
  minBalanceMicro: 50_000,
  providers: [
    {
      available: false,
      label: "ChatGPT",
      models: [{ id: "gpt-6-sol", name: "GPT-6 Sol", price }],
      provider: "chatgpt",
    },
    {
      available: true,
      label: "DeepSeek",
      models: [
        { id: "deepseek-flash", name: "DeepSeek Flash", price },
        { id: "deepseek-pro", name: "DeepSeek Pro", price },
      ],
      provider: "deepseek",
    },
    {
      available: true,
      label: "Groq",
      models: [{ id: "openai/gpt-oss-20b", name: "GPT OSS 20B", price }],
      provider: "groq",
    },
  ],
  cardTopUp: false,
  testTopUp: true,
};

function signIn(pricing: ServicePricing = { ...offer, providers: [] }) {
  vi.spyOn(authService, "session").mockResolvedValue({
    id: "33333333-3333-4333-8333-333333333333",
    recoveryEmail: null,
    username: "ban",
  });
  vi.spyOn(serviceBillingService, "pricing").mockResolvedValue(pricing);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(copyText).mockClear();
});

describe("Service keys", () => {
  it("sends a visitor to Pricing and requests nothing", async () => {
    vi.spyOn(authService, "session").mockResolvedValue(null);
    const listMock = vi.spyOn(serviceKeysService, "list");

    renderRoute();

    expect(await screen.findByText("Pricing page")).toBeVisible();
    expect(listMock).not.toHaveBeenCalled();
  });

  it("lists the keys, masked, with when each was made and last used", async () => {
    signIn();
    vi.spyOn(serviceKeysService, "list").mockResolvedValue([fresh, older]);

    renderRoute();

    expect(await screen.findByText("hw_svc_********xB_E")).toBeVisible();
    expect(screen.getByText("hw_svc_********6789")).toBeVisible();
    expect(screen.getByText("2 active keys.")).toBeVisible();
    expect(
      screen.getByText(/Created Nov 1, 2026 · last used Nov 5, 2026/),
    ).toBeVisible();
    expect(screen.getByText(/Created Nov 6, 2026 · never used/)).toBeVisible();
  });

  it("says so when there is no key yet", async () => {
    signIn();
    vi.spyOn(serviceKeysService, "list").mockResolvedValue([]);

    renderRoute();

    expect(await screen.findByText("You have no keys yet.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Create key" })).toBeEnabled();
  });

  it("shows how to use a key, with the Pricing models and the minimum balance", async () => {
    signIn();
    vi.spyOn(serviceKeysService, "list").mockResolvedValue([]);

    renderRoute();

    expect(
      await screen.findByRole("heading", { name: "Use a key" }),
    ).toBeVisible();
    expect(screen.getByText(/\/gateway\/openai\/v1\/responses/)).toBeVisible();
    expect(
      screen.getByText(/Name a model from the Pricing page/),
    ).toBeVisible();
    expect(
      await screen.findByText(/and needs \$0\.05 in it to start/),
    ).toBeVisible();
    expect(screen.getByText(/It never uses your own agents/)).toBeVisible();
  });

  it("shows a new key once, can copy it, and adds it to the list", async () => {
    signIn();
    vi.spyOn(serviceKeysService, "list").mockResolvedValue([older]);
    const createMock = vi
      .spyOn(serviceKeysService, "create")
      .mockResolvedValue(fresh);
    const user = userEvent.setup();

    renderRoute();

    await user.click(await screen.findByRole("button", { name: "Create key" }));

    expect(createMock).toHaveBeenCalledOnce();
    expect(
      await screen.findByText("Copy it now — this key is shown once"),
    ).toBeVisible();
    expect(
      screen.getByLabelText("Copy it now — this key is shown once"),
    ).toHaveValue(fresh.key);
    expect(screen.getByText("hw_svc_********6789")).toBeVisible();
    expect(screen.getByText("2 active keys.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Copy service key" }));

    expect(copyText).toHaveBeenCalledWith(fresh.key);
  });

  it("revokes a key and takes it off the list", async () => {
    signIn();
    vi.spyOn(serviceKeysService, "list").mockResolvedValue([fresh, older]);
    const revokeMock = vi
      .spyOn(serviceKeysService, "revoke")
      .mockResolvedValue(undefined);
    const user = userEvent.setup();

    renderRoute();

    await user.click(
      await screen.findByRole("button", { name: "Revoke key ending xB_E" }),
    );

    expect(revokeMock).toHaveBeenCalledWith(older.id);
    expect(screen.queryByText("hw_svc_********xB_E")).not.toBeInTheDocument();
    expect(screen.getByText("1 active key.")).toBeVisible();
  });

  it("shows the API message when a key cannot be created", async () => {
    signIn();
    vi.spyOn(serviceKeysService, "list").mockResolvedValue([]);
    vi.spyOn(serviceKeysService, "create").mockRejectedValue(
      new Error("You hold the most service keys allowed. Revoke one first."),
    );
    const user = userEvent.setup();

    renderRoute();

    await user.click(await screen.findByRole("button", { name: "Create key" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You hold the most service keys allowed. Revoke one first.",
    );
  });

  it("reports a failure to load the keys and loads again on Retry", async () => {
    signIn();
    const listMock = vi
      .spyOn(serviceKeysService, "list")
      .mockRejectedValueOnce(
        new Error("The service key service is unavailable."),
      )
      .mockResolvedValue([older]);
    const user = userEvent.setup();

    renderRoute();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The service key service is unavailable.",
    );

    await user.click(
      within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }),
    );

    expect(await screen.findByText("hw_svc_********xB_E")).toBeVisible();
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  describe("Use a key", () => {
    it("starts on an agent the platform can serve and writes the curl command for it", async () => {
      signIn(offer);
      vi.spyOn(serviceKeysService, "list").mockResolvedValue([]);

      renderRoute();

      // ChatGPT is first in the list but has no account, so DeepSeek is chosen.
      await waitFor(() =>
        expect(screen.getByLabelText("Agent")).toHaveTextContent("DeepSeek"),
      );
      expect(screen.getByLabelText("Model")).toHaveTextContent(
        "deepseek-flash",
      );
      const curl = screen.getByText(/^curl -N /);
      expect(curl).toHaveTextContent("/gateway/deepseek/responses");
      expect(curl).toHaveTextContent("Authorization: Bearer YOUR_SERVICE_KEY");
      expect(curl).toHaveTextContent('"model":"deepseek-flash"');
      expect(curl).toHaveTextContent("Hello, how are you?");
    });

    it("follows the agent and the model that are chosen, and lists an agent with no account as unavailable", async () => {
      signIn(offer);
      vi.spyOn(serviceKeysService, "list").mockResolvedValue([]);
      const user = userEvent.setup();

      renderRoute();

      await waitFor(() =>
        expect(screen.getByLabelText("Agent")).toHaveTextContent("DeepSeek"),
      );
      await user.click(screen.getByLabelText("Model"));
      await user.click(screen.getByRole("option", { name: "deepseek-pro" }));
      expect(screen.getByText(/^curl -N /)).toHaveTextContent(
        '"model":"deepseek-pro"',
      );

      await user.click(screen.getByLabelText("Agent"));
      expect(
        screen.getByRole("option", { name: "ChatGPT · unavailable" }),
      ).toHaveAttribute("aria-disabled", "true");
      await user.click(screen.getByRole("option", { name: "Groq" }));

      // A new agent starts on its own first model.
      expect(screen.getByLabelText("Model")).toHaveTextContent(
        "openai/gpt-oss-20b",
      );
      expect(screen.getByText(/^curl -N /)).toHaveTextContent(
        "/gateway/groq/v1/responses",
      );
    });

    it("copies the command with a placeholder until there is a key, then with the key", async () => {
      signIn(offer);
      vi.spyOn(serviceKeysService, "list").mockResolvedValue([]);
      const user = userEvent.setup();

      renderRoute();

      await user.click(
        await screen.findByRole("button", { name: "Copy curl command" }),
      );

      expect(vi.mocked(copyText).mock.calls[0][0]).toContain(
        "Authorization: Bearer YOUR_SERVICE_KEY",
      );

      await user.type(screen.getByLabelText("Key"), "  hw_svc_pasted  ");

      expect(screen.getByText(/^curl -N /)).toHaveTextContent(
        "Authorization: Bearer hw_svc_pasted",
      );
      await user.click(
        screen.getByRole("button", { name: "Copy curl command" }),
      );
      expect(vi.mocked(copyText).mock.calls[1][0]).toContain(
        'Authorization: Bearer hw_svc_pasted" ',
      );
    });

    it("sends a fixed message, with no field to change it and no sentence beside Run test", async () => {
      signIn(offer);
      vi.spyOn(serviceKeysService, "list").mockResolvedValue([]);

      renderRoute();

      expect(await screen.findByText(/^curl -N /)).toHaveTextContent(
        "Hello, how are you?",
      );
      expect(screen.queryByLabelText("Message")).toBeNull();
      // Run test stands alone: no sentence beside it.
      expect(
        screen.queryByText(/It is charged like any other request/),
      ).toBeNull();
    });

    it("lays the guide out as Agent, Key, Copy, the command, then Run test", async () => {
      signIn(offer);
      vi.spyOn(serviceKeysService, "list").mockResolvedValue([]);

      renderRoute();

      const guide = (
        await screen.findByRole("heading", { name: "Use a key" })
      ).closest("section") as HTMLElement;
      await waitFor(() =>
        expect(within(guide).getByLabelText("Agent")).toBeVisible(),
      );
      const order = [
        within(guide).getByLabelText("Agent"),
        within(guide).getByLabelText("Key"),
        within(guide).getByRole("button", { name: "Copy curl command" }),
        within(guide).getByText(/^curl -N /),
        within(guide).getByRole("button", { name: "Run test" }),
      ];

      order.slice(1).forEach((element, index) => {
        expect(
          order[index].compareDocumentPosition(element) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      });
    });

    it("runs the test with the key just made, shows the answer and reads the balance again", async () => {
      signIn(offer);
      vi.spyOn(serviceKeysService, "list").mockResolvedValue([]);
      vi.spyOn(serviceKeysService, "create").mockResolvedValue(fresh);
      const client = createQueryClient();
      const invalidateMock = vi.spyOn(client, "invalidateQueries");
      const runMock = vi
        .spyOn(serviceKeyTestService, "run")
        .mockImplementation(async ({ onDelta }) => {
          onDelta("I am ");
          onDelta("fine, thank you.");

          return { durationMs: 1234, status: 200 };
        });
      const user = userEvent.setup();

      renderRoute(client);

      await user.click(
        await screen.findByRole("button", { name: "Create key" }),
      );
      // The key is shown once, so the field and the command start with it.
      expect(await screen.findByLabelText("Key")).toHaveValue(fresh.key);
      expect(screen.getByText(/^curl -N /)).toHaveTextContent(
        `Authorization: Bearer ${fresh.key}`,
      );
      await user.click(screen.getByRole("button", { name: "Run test" }));

      expect(await screen.findByText("I am fine, thank you.")).toBeVisible();
      expect(screen.getByText("HTTP 200 · 1.2 s")).toBeVisible();
      expect(runMock).toHaveBeenCalledOnce();
      expect(runMock.mock.calls[0][0]).toMatchObject({
        key: fresh.key,
        message: "Hello, how are you?",
        model: "deepseek-flash",
        provider: "deepseek",
      });
      expect(invalidateMock).toHaveBeenCalledWith({
        queryKey: serviceBillingService.walletQueryKey(
          "33333333-3333-4333-8333-333333333333",
        ),
      });
    });

    it("needs a key before it can run, and takes one that is pasted", async () => {
      signIn(offer);
      vi.spyOn(serviceKeysService, "list").mockResolvedValue([]);
      const runMock = vi
        .spyOn(serviceKeyTestService, "run")
        .mockResolvedValue({ durationMs: 10, status: 200 });
      const user = userEvent.setup();

      renderRoute();

      expect(
        await screen.findByRole("button", { name: "Run test" }),
      ).toBeDisabled();

      await user.type(screen.getByLabelText("Key"), "  hw_svc_pasted  ");

      expect(screen.getByRole("button", { name: "Run test" })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: "Run test" }));

      expect(runMock.mock.calls[0][0].key).toBe("hw_svc_pasted");
    });

    it("says why a test failed, and reads the balance again in case it was charged", async () => {
      signIn(offer);
      vi.spyOn(serviceKeysService, "list").mockResolvedValue([]);
      const client = createQueryClient();
      const invalidateMock = vi.spyOn(client, "invalidateQueries");
      vi.spyOn(serviceKeyTestService, "run").mockRejectedValue(
        new ServiceKeyTestError("The model completed without a text answer."),
      );
      const user = userEvent.setup();

      renderRoute(client);

      await user.type(await screen.findByLabelText("Key"), "hw_svc_pasted");
      await user.click(screen.getByRole("button", { name: "Run test" }));

      expect(
        await screen.findByText("The model completed without a text answer."),
      ).toBeVisible();
      expect(invalidateMock).toHaveBeenCalledWith({
        queryKey: serviceBillingService.walletQueryKey(
          "33333333-3333-4333-8333-333333333333",
        ),
      });
      expect(screen.getByRole("button", { name: "Run test" })).toBeEnabled();
    });

    it("fills the field with a key made after one was pasted", async () => {
      signIn(offer);
      vi.spyOn(serviceKeysService, "list").mockResolvedValue([]);
      vi.spyOn(serviceKeysService, "create").mockResolvedValue(fresh);
      const user = userEvent.setup();

      renderRoute();

      await user.type(await screen.findByLabelText("Key"), "hw_svc_pasted");
      expect(screen.getByLabelText("Key")).toHaveValue("hw_svc_pasted");
      await user.click(screen.getByRole("button", { name: "Create key" }));

      await waitFor(() =>
        expect(screen.getByLabelText("Key")).toHaveValue(fresh.key),
      );
    });

    it("will not run against an agent the platform has no account for", async () => {
      signIn({
        ...offer,
        providers: offer.providers.map((entry) => ({
          ...entry,
          available: false,
        })),
      });
      vi.spyOn(serviceKeysService, "list").mockResolvedValue([]);
      const user = userEvent.setup();

      renderRoute();

      await user.type(await screen.findByLabelText("Key"), "hw_svc_pasted");

      expect(screen.getByRole("button", { name: "Run test" })).toBeDisabled();
    });

    it("shows the command alone, with an example model, until the prices load", async () => {
      signIn();
      vi.spyOn(serviceKeysService, "list").mockResolvedValue([]);

      renderRoute();

      expect(await screen.findByText(/^curl -N /)).toHaveTextContent(
        '"model":"YOUR_MODEL"',
      );
      expect(screen.queryByRole("button", { name: "Run test" })).toBeNull();
      expect(screen.queryByLabelText("Agent")).toBeNull();
    });
  });
});
