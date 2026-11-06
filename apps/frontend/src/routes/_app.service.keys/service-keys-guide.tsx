import { useState } from "react";
import { Copy } from "lucide-react";

import AgentsProviderIcon from "@/components/agents-provider-icon";
import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AgentProviderId } from "@/services/agent/agent-types";
import type { ServicePricing } from "@/services/service-billing/service-billing-types";
import {
  serviceKeyCurl,
  TEST_MESSAGE,
} from "@/services/service-key-test/service-key-test-request";
import { copyText } from "@/utils/utils.clipboard";
import { resolveGatewayOrigin } from "@/utils/utils.gateway-config";
import { formatDollars } from "@/utils/utils.money";

import ServiceKeysTest from "./service-keys-test";

// Stands in for the key in the command until there is one.
const KEY_PLACEHOLDER = "YOUR_SERVICE_KEY";

// Shown until the prices, and so the models, have loaded.
const EXAMPLE_MODEL = "YOUR_MODEL";

interface ServiceKeysGuideProps {
  // The agents and models on offer, once prices have loaded.
  pricing?: ServicePricing;
  // A key made on this page; it fills the Key field.
  createdKey?: { id: string; key: string };
  // Called when a test request ends, so the balance can be read again.
  onTested: () => void;
}

// How to send a first request with a service key, top to bottom: the agent, the
// key, the command that carries both, and a test that sends it from the page.
export default function ServiceKeysGuide({
  createdKey,
  onTested,
  pricing,
}: ServiceKeysGuideProps) {
  const origin = resolveGatewayOrigin(window.location.origin);
  const [chosenProvider, setChosenProvider] = useState<AgentProviderId>();
  const [chosenModel, setChosenModel] = useState<string>();
  // What was typed, and the key it was typed over. A key made after that fills
  // the field again.
  const [typedKey, setTypedKey] = useState<{
    value: string;
    over: string | undefined;
  }>();

  // Agents with a model to name; one the platform can serve now comes first.
  const providers = (pricing?.providers ?? []).filter(
    (entry) => entry.models.length > 0,
  );
  const provider =
    providers.find((entry) => entry.provider === chosenProvider) ??
    providers.find((entry) => entry.available) ??
    providers[0];
  const model =
    provider?.models.find((entry) => entry.id === chosenModel) ??
    provider?.models[0];
  const keyField =
    typedKey && typedKey.over === createdKey?.id
      ? typedKey.value
      : (createdKey?.key ?? "");
  const apiKey = keyField.trim();
  const curl = serviceKeyCurl({
    key: apiKey || KEY_PLACEHOLDER,
    message: TEST_MESSAGE,
    model: model?.id ?? EXAMPLE_MODEL,
    origin,
    provider: provider?.provider ?? "chatgpt",
  });

  return (
    <section className="space-y-5 rounded-xl border border-zinc-200 bg-white p-4 shadow-xs">
      <div className="space-y-1">
        <h2 className="font-heading text-sm font-semibold">Use a key</h2>

        <p className="text-xs text-zinc-500">
          A service key works with any client of the gateway. Point the client
          at <span className="font-mono text-zinc-700">{origin}/gateway/…</span>{" "}
          and give it the key.
        </p>
      </div>

      {provider && model && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="service-guide-provider">Agent</Label>

            <Select
              value={provider.provider}
              onValueChange={(value) => {
                setChosenProvider(value as AgentProviderId);
                setChosenModel(undefined);
              }}
            >
              <SelectTrigger
                className="h-10! w-full min-w-0 bg-white"
                id="service-guide-provider"
              >
                <SelectValue />
              </SelectTrigger>

              <SelectContent>
                {providers.map((entry) => (
                  <SelectItem
                    key={entry.provider}
                    disabled={!entry.available}
                    value={entry.provider}
                  >
                    <AgentsProviderIcon provider={entry.provider} />

                    <span>
                      {entry.label}
                      {entry.available ? "" : " · unavailable"}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="service-guide-model">Model</Label>

            <Select value={model.id} onValueChange={setChosenModel}>
              <SelectTrigger
                className="h-10! w-full min-w-0 bg-white"
                id="service-guide-model"
              >
                <SelectValue />
              </SelectTrigger>

              <SelectContent>
                {provider.models.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="service-guide-key">Key</Label>

        <Input
          autoComplete="off"
          className="h-10 font-mono text-xs"
          id="service-guide-key"
          placeholder="hw_svc_… (a key is shown only when it is made, so paste an older one)"
          type="password"
          value={keyField}
          onChange={(event) =>
            setTypedKey({ over: createdKey?.id, value: event.target.value })
          }
        />

        <Flex className="justify-end">
          <Button
            aria-label="Copy curl command"
            className="h-7 px-2 text-[11px]"
            onClick={() => void copyText(curl)}
            type="button"
            variant="outline"
          >
            <Copy aria-hidden="true" />
            Copy
          </Button>
        </Flex>

        <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-3 font-mono text-zinc-100 text-[11px]/relaxed">
          {curl}
        </pre>
      </div>

      {provider && model && (
        <ServiceKeysTest
          apiKey={apiKey}
          available={provider.available}
          model={model.id}
          origin={origin}
          provider={provider.provider}
          onTested={onTested}
        />
      )}

      <ul className="list-disc space-y-1 pl-5 text-xs text-zinc-600">
        <li>
          Name a model from the Pricing page. A request for any other model is
          refused.
        </li>

        <li>
          Each request is charged to your balance at the price of its model
          {pricing
            ? `, and needs ${formatDollars(pricing.minBalanceMicro)} in it to start`
            : ""}
          .
        </li>

        <li>
          A service key is served by the platform&rsquo;s accounts. It never
          uses your own agents, and your own Hub keys are never charged.
        </li>
      </ul>
    </section>
  );
}
