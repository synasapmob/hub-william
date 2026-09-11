import { Plug } from "lucide-react";
import { tv } from "tailwind-variants";

import CopyBlock from "@/components/copy-block";
import CopyCommand from "@/components/copy-command";
import Flex from "@/components/ui/flex";
import catalogService, { type CatalogCollection } from "@/services/catalog";
import {
  GATEWAY_KEY_PLACEHOLDER,
  gatewayAgentConfigs,
  gatewayInstallCommand,
  resolveGatewayOrigin,
} from "@/utils/utils.gateway-config";
import useSiteOrigin from "@/utils/utils.site-origin";

const toolUsage = tv({
  slots: {
    container: "ml-2 space-y-5",
    section: "space-y-2",
    label:
      "font-mono text-[10px] font-semibold tracking-wider text-zinc-500 uppercase",
    description: "text-zinc-600 text-sm/relaxed",
  },
});

interface CatalogCanvasToolUsageProps {
  collection: CatalogCollection;
}

function bootstrapCommand(origin: string, arguments_: string) {
  const suffix = arguments_ ? ` ${arguments_}` : "";

  return `curl -fsSL ${catalogService.installerUrl(origin)} | python3 -${suffix}`;
}

function gatewayCommand(origin: string) {
  return gatewayInstallCommand({
    gatewayOrigin: resolveGatewayOrigin(origin),
    installerUrl: catalogService.gatewayInstallerUrl(origin),
  });
}

/** Install commands, and for the gateway the config those commands write. */
export default function CatalogCanvasToolUsage({
  collection,
}: CatalogCanvasToolUsageProps) {
  const { container, section, label, description } = toolUsage();
  const siteOrigin = useSiteOrigin();

  if (collection.id === "documents") {
    return (
      <div className={container()}>
        <div className={section()}>
          <p className={label()}>Global machine</p>

          <p className={description()}>
            Downloads the installer, opens its terminal picker with the defaults
            selected, and applies the selection after the confirmation.
          </p>

          <CopyCommand command={bootstrapCommand(siteOrigin, "")} />
        </div>

        <div className={section()}>
          <p className={label()}>Current project</p>

          <p className={description()}>
            Installs a managed copy below <code>.agents/rules</code> and adds a
            small dispatcher block to the project&rsquo;s AGENTS and CLAUDE
            files without replacing their existing instructions.
          </p>

          <CopyCommand
            command={bootstrapCommand(siteOrigin, '--path "$PWD"')}
          />
        </div>
      </div>
    );
  }

  if (collection.id === "gateway") {
    const configs = gatewayAgentConfigs(resolveGatewayOrigin(siteOrigin));

    return (
      <div className={container()}>
        <div className={section()}>
          <p className={label()}>Interactive install</p>

          <p className={description()}>
            Paste your key into <code>--key</code>. The picker starts with
            Codex, Claude Code, and Grok selected; Space toggles, Enter injects
            into the selected configs, Escape exits without changes.
          </p>

          <CopyCommand command={gatewayCommand(siteOrigin)} />
        </div>

        <div className={section()}>
          <p className={label()}>Manual config</p>

          <p className={description()}>
            Already have a gateway key? Paste the matching block into the agent
            file, replacing <code>{GATEWAY_KEY_PLACEHOLDER}</code>, then restart
            the CLI.
          </p>
        </div>

        {configs.map((config) => (
          <div className={section()} key={config.agent}>
            <p className={label()}>{config.label}</p>

            <p className={description()}>
              <code>{config.path}</code> · {config.protocol}
            </p>

            <CopyBlock source={config.source} />
          </div>
        ))}
      </div>
    );
  }

  const products = catalogService.mcpProducts();

  return (
    <div className={container()}>
      <div className={section()}>
        <p className={label()}>Available MCPs</p>

        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200/80 bg-card">
          {products.map((product) => (
            <li key={product.id} className="px-4 py-3">
              <Flex className="items-start gap-3">
                <Plug
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-indigo-600"
                />

                <div className="min-w-0 flex-1">
                  <p className="font-medium text-zinc-900 text-sm/normal">
                    {product.label}
                  </p>

                  <p className="mt-1 text-muted-foreground text-xs/relaxed">
                    {product.description}
                  </p>

                  {product.servers.length > 1 ? (
                    <p className="mt-1 font-mono text-[10px] text-slate-400">
                      {product.servers.length} project-scoped servers
                    </p>
                  ) : null}
                </div>
              </Flex>
            </li>
          ))}
        </ul>
      </div>

      <div className={section()}>
        <p className={label()}>Install all</p>

        <CopyCommand command={bootstrapCommand(siteOrigin, "--mcp all")} />
      </div>

      <div className={section()}>
        <p className={label()}>Install selected</p>

        <CopyCommand
          command={bootstrapCommand(siteOrigin, "--mcp linear,playwright")}
        />

        <p className="text-muted-foreground text-xs/relaxed">
          Use the identifiers shown above, separated by commas. Supabase expands
          to the configured project-scoped servers instead of one account-wide
          connection.
        </p>
      </div>
    </div>
  );
}
