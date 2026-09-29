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
    includeKey: true,
  });
}

function ompCommand(origin: string) {
  return ompInstallCommand({
    gatewayOrigin: resolveGatewayOrigin(origin),
    installerUrl: catalogService.ompInstallerUrl(origin),
    includeKey: true,
  });
}

/** Install commands, and for the gateway the config those commands write. */
export default function ToolsCatalogToolUsage({
  collection,
}: ToolsCatalogToolUsageProps) {
  const { container, section, label, description } = toolUsage();
  const siteOrigin = useSiteOrigin();

  if (collection.id === "download-reel") {
    return (
      <div className={container()}>
        <div className={section()}>
          <p className={label()}>Run with your reel URL</p>

          <p className={description()}>
            Use Bash and Python 3 on macOS, Linux or WSL. TikTok also requires
            yt-dlp. On macOS, install it with <code>brew install yt-dlp</code>.
          </p>

          <p className={description()}>
            Replace <code>REEL_URL</code> with your reel link, keep the quotes,
            then run the command in your terminal. No script file to save first.
          </p>
        </div>

        {["tiktok", "facebook"].map((platform) => (
          <div className={section()} key={platform}>
            <p className={label()}>
              {platform === "tiktok" ? "TikTok" : "Facebook"}
            </p>

            <CopyCommand
              command={`curl -fsSL ${catalogService.downloadReelScriptUrl(siteOrigin)} | bash -s -- --platform=${platform} --url='REEL_URL'`}
            />
          </div>
        ))}

        <div className={section()}>
          <p className={description()}>
            Videos with sound go to <code>~/Downloads</code>; existing files are
            kept. Add <code>--output-dir='./videos'</code> to choose another
            folder.
          </p>

          <p className={description()}>
            Downloads run on your computer. Private videos or platform
            restrictions can prevent a download. Keep yt-dlp up to date.
          </p>
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
          <p className={label()}>Pass a key explicitly</p>

          <p className={description()}>
            Replace <code>{GATEWAY_KEY_PLACEHOLDER}</code> before running this
            command. A key passed on the command line may remain in shell
            history.
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
          <p className={label()}>Pass a key explicitly</p>

          <p className={description()}>
            Replace <code>{GATEWAY_KEY_PLACEHOLDER}</code> before running this
            command. A key passed on the command line may remain in shell
            history.
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
