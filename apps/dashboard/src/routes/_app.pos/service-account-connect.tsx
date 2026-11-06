import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  agentConnectionService,
  type AgentConnection,
  type Authorization,
} from "@/services/agent-connection/agent-connection-service";
import { serviceProviderLabels } from "@/services/sales/sales-labels";
import type {
  ServiceProvider,
  VerifiedAccount,
} from "@/services/sales/sales-types";
import { serviceStockService } from "@/services/service-stock/service-stock-service";

type Method = "callback" | "device" | "key";

// How each agent is connected on Hub William: by signing in at the provider and
// pasting the address it sends back, by a code typed at the provider, or by a key.
const METHODS: Record<ServiceProvider, Method> = {
  chatgpt: "callback",
  claude: "callback",
  deepseek: "key",
  gemini: "callback",
  grok: "device",
  groq: "key",
};

const MINIMUM_POLL_SECONDS = 2;

// The window the provider's sign-in opens in, as the Agents page opens it.
const POPUP_NAME = "hub-william-agent-connect";
const POPUP_FEATURES = "popup,width=720,height=820";

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : undefined;
}

interface ServiceAccountConnectProps {
  provider: ServiceProvider;
  /** The connection made here, as soon as there is one, so it can be let go if it is not sold. */
  onConnection: (id: string | null) => void;
  /** The account the provider answered for, or null while there is none. */
  onVerified: (account: VerifiedAccount | null) => void;
  disabled: boolean;
}

/**
 * Connects an agent account the way Hub William's Agents page does, and verifies it:
 * the provider is asked for something through it, and what it has left is shown.
 * Nothing is sold until this has passed.
 */
export default function ServiceAccountConnect({
  disabled,
  onConnection,
  onVerified,
  provider,
}: ServiceAccountConnectProps) {
  const method = METHODS[provider];
  const name = serviceProviderLabels[provider];

  const [connection, setConnection] = useState<AgentConnection | null>(null);
  const [authorization, setAuthorization] = useState<Authorization | null>(
    null,
  );
  const [callbackUrl, setCallbackUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [working, setWorking] = useState(false);
  const [account, setAccount] = useState<VerifiedAccount | null>(null);

  const connected = connection?.status === "connected";

  async function verify(id: string) {
    try {
      const verified = await serviceStockService.verify(id);

      setAccount(verified);
      onVerified(verified);
    } catch (error) {
      toast.error("Verify không qua", { description: messageOf(error) });
    }
  }

  // A code typed at the provider finishes on its own: ask now and then until it has.
  useEffect(() => {
    if (method !== "device" || !connection || connection.status !== "pending")
      return;

    const timer = setTimeout(
      async () => {
        try {
          const next = await agentConnectionService.get(connection.id);

          setConnection(next);

          if (next.status === "connected") await verify(next.id);

          if (next.status === "failed")
            toast.error("Kết nối không thành công", {
              description: next.failureMessage ?? undefined,
            });
        } catch (error) {
          toast.error("Không đọc được kết nối", {
            description: messageOf(error),
          });
        }
      },
      Math.max(authorization?.pollAfterSeconds ?? 0, MINIMUM_POLL_SECONDS) *
        1000,
    );

    return () => clearTimeout(timer);
    // `verify` only reads what the next poll has just been given.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, connection, authorization]);

  async function begin() {
    // The window opens now, inside the click, so the browser lets it open; it is sent
    // to the provider once the sign-in has started and there is an address to go to.
    const popup = window.open("about:blank", POPUP_NAME, POPUP_FEATURES);

    if (!popup) {
      toast.error("Trình duyệt chặn cửa sổ đăng nhập", {
        description: "Cho phép popup cho dashboard rồi bấm lại.",
      });

      return;
    }

    popup.opener = null;
    setWorking(true);

    try {
      const started = await agentConnectionService.start(provider);

      if (!started.authorization) {
        popup.close();
        // Nothing to sign in to, so nothing to keep.
        void agentConnectionService
          .disconnect(started.id)
          .catch(() => undefined);
        toast.error("Nhà cung cấp không trả về trang đăng nhập");

        return;
      }

      popup.location.replace(started.authorization.url);
      setConnection(started);
      setAuthorization(started.authorization);
      onConnection(started.id);
    } catch (error) {
      popup.close();
      toast.error("Không bắt đầu kết nối được", {
        description: messageOf(error),
      });
    } finally {
      setWorking(false);
    }
  }

  async function connectAndVerify() {
    setWorking(true);

    try {
      let current = connection;

      if (!connected) {
        if (method === "key") {
          current = await agentConnectionService.connectKey(
            provider as "deepseek" | "groq",
            apiKey,
          );
          onConnection(current.id);
        } else if (connection) {
          current = await agentConnectionService.complete(
            connection.id,
            callbackUrl,
          );
        }

        setConnection(current);
      }

      if (current?.status !== "connected") {
        toast.error("Chưa kết nối được", {
          description:
            current?.failureMessage ??
            "Đăng nhập chưa xong, hoặc địa chỉ dán vào chưa đúng.",
        });

        return;
      }

      await verify(current.id);
    } catch (error) {
      toast.error("Chưa kết nối được", { description: messageOf(error) });
    } finally {
      setWorking(false);
    }
  }

  const canVerify =
    !disabled &&
    !working &&
    (method === "key"
      ? connected || apiKey.trim() !== ""
      : connected || (connection !== null && callbackUrl.trim() !== ""));

  return (
    <div className="space-y-3 rounded-lg border p-3">
      {method === "key" && !connected && (
        <div className="space-y-1.5">
          <Label htmlFor="listing-api-key">API key {name}</Label>

          <Input
            autoComplete="off"
            disabled={disabled || working}
            id="listing-api-key"
            spellCheck={false}
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />

          <p className="text-xs text-muted-foreground">
            Key này là của account bạn sẽ bán. Hub William lưu nó mã hóa như khi
            bạn kết nối ở trang Agents.
          </p>
        </div>
      )}

      {method !== "key" && !connection && (
        <Button
          disabled={disabled || working}
          type="button"
          variant="outline"
          onClick={() => void begin()}
        >
          {method === "device" ? "Lấy mã đăng nhập" : "Lấy link đăng nhập"}
        </Button>
      )}

      {method === "callback" && connection && !connected && authorization && (
        <div className="space-y-2">
          <a
            className="inline-block text-sm text-blue-700 underline"
            href={authorization.url}
            rel="noreferrer"
            target="_blank"
          >
            Mở lại trang đăng nhập {name}
          </a>

          <div className="space-y-1.5">
            <Label htmlFor="listing-callback">Callback URL</Label>

            <Input
              autoComplete="off"
              disabled={disabled || working}
              id="listing-callback"
              placeholder="Dán địa chỉ trang trả về sau khi đăng nhập"
              spellCheck={false}
              value={callbackUrl}
              onChange={(event) => setCallbackUrl(event.target.value)}
            />

            <p className="text-xs text-muted-foreground">
              Cửa sổ đăng nhập vừa mở. Đăng nhập xong, trình duyệt chuyển tới
              một địa chỉ không mở được: copy cả địa chỉ đó dán vào đây.
            </p>
          </div>
        </div>
      )}

      {method === "device" && connection && !connected && authorization && (
        <div className="space-y-2 text-sm">
          <a
            className="inline-block text-blue-700 underline"
            href={authorization.url}
            rel="noreferrer"
            target="_blank"
          >
            Mở lại trang đăng nhập {name}
          </a>

          {authorization.userCode && (
            <p>
              Nhập mã{" "}
              <strong className="font-mono">{authorization.userCode}</strong>
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            Đang chờ bạn đăng nhập…
          </p>
        </div>
      )}

      {account && (
        <div className="space-y-1 rounded-lg bg-emerald-50 p-2.5 text-xs text-emerald-900">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <Check aria-hidden={true} className="size-4" />
            Đã verify
            {account.account_label || account.plan
              ? ` · ${[account.account_label, account.plan].filter(Boolean).join(" · ")}`
              : ""}
          </p>

          {account.quota.length > 0 ? (
            <ul>
              {account.quota.map((metric) => (
                <li key={metric.label}>
                  {metric.label}: {metric.value}
                  {metric.detail && ` (${metric.detail})`}
                </li>
              ))}
            </ul>
          ) : (
            <p>Nhà cung cấp không cho đọc quota, hoặc chưa đọc được lúc này.</p>
          )}
        </div>
      )}

      <Button
        disabled={!canVerify}
        type="button"
        onClick={() => void connectAndVerify()}
      >
        {account ? "Verify lại" : "Verify"}
      </Button>
    </div>
  );
}
