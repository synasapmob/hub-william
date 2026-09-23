import { tv } from "tailwind-variants";

import CopyBlock from "@/components/copy-block";
import CopyCommand from "@/components/copy-command";
import catalogService, { type CatalogCollection } from "@/services/catalog";
import {
  GATEWAY_KEY_PLACEHOLDER,
  gatewayAgentConfigs,
  gatewayInstallCommand,
  resolveGatewayOrigin,
} from "@/utils/utils.gateway-config";
import { openCodeInstallCommand } from "@/utils/utils.opencode-config";
import { ompInstallCommand } from "@/utils/utils.omp-config";
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

interface ToolsCatalogToolUsageProps {
  collection: CatalogCollection;
}

function gatewayCommand(origin: string) {
  return gatewayInstallCommand({
    gatewayOrigin: resolveGatewayOrigin(origin),
    installerUrl: catalogService.gatewayInstallerUrl(origin),
  });
}

function openCodeCommand(origin: string) {
  return openCodeInstallCommand({
    gatewayOrigin: resolveGatewayOrigin(origin),
    installerUrl: catalogService.openCodeInstallerUrl(origin),
  });
}

function ompCommand(origin: string) {
  return ompInstallCommand({
    gatewayOrigin: resolveGatewayOrigin(origin),
    installerUrl: catalogService.ompInstallerUrl(origin),
  });
}

/** Install commands, and for the gateway the config those commands write. */
export default function ToolsCatalogToolUsage({
  collection,
}: ToolsCatalogToolUsageProps) {
  const { container, section, label, description } = toolUsage();
  const siteOrigin = useSiteOrigin();

  if (collection.id === "gateway") {
    const configs = gatewayAgentConfigs(resolveGatewayOrigin(siteOrigin));

    return (
      <div className={container()}>
        <div className={section()}>
          <p className={label()}>Interactive install</p>

          <p className={description()}>
            The installer asks for your Hub key in a hidden prompt. The picker
            starts with Codex, Claude Code, Antigravity, and Grok selected;
            Space toggles, Enter injects into the selected configs, Escape exits
            without changes.
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

  if (collection.id === "opencode") {
    return (
      <div className={container()}>
        <div className={section()}>
          <p className={label()}>Install all live providers</p>

          <p className={description()}>
            Enter one Hub key in the installer&rsquo;s hidden prompt. It
            discovers models from your connected Codex, Claude, Gemini/AGY,
            Grok, and DeepSeek pools and merges them into OpenCode.
          </p>

          <CopyCommand command={openCodeCommand(siteOrigin)} />
        </div>

        <div className={section()}>
          <p className={label()}>Use in OpenCode</p>

          <p className={description()}>
            Start <code>opencode</code>, use <code>/models</code> to switch
            provider or model, and use the native <code>/variants</code> picker
            for reasoning effort. Supported models default to medium effort. AGY
            models whose effort is part of the model ID stay selectable in{" "}
            <code>/models</code>.
          </p>
        </div>

        <div className={section()}>
          <p className={description()}>
            Upstream provider credentials stay encrypted on Hub William.
          </p>
        </div>
      </div>
    );
  }

  if (collection.id === "omp") {
    return (
      <div className={container()}>
        <div className={section()}>
          <p className={label()}>Install all live providers</p>

          <p className={description()}>
            Enter one Hub key in the installer&rsquo;s hidden prompt. It
            discovers models from your connected Codex, Claude, Gemini/AGY,
            Grok, and DeepSeek pools and merges namespaced providers into
            OMP&rsquo;s native <code>models.yml</code>.
          </p>

          <CopyCommand command={ompCommand(siteOrigin)} />
        </div>

        <div className={section()}>
          <p className={label()}>Use in OMP</p>

          <p className={description()}>
            Start <code>omp</code> and use <code>/model</code> to switch between
            the installed Hub providers and models. Re-run the command when a
            connected provider&rsquo;s live catalogue changes.
          </p>
        </div>

        <div className={section()}>
          <p className={description()}>
            The installer preserves providers outside its marked block and keeps
            upstream credentials encrypted on Hub William.
          </p>
        </div>
      </div>
    );
  }

  return null;
}
