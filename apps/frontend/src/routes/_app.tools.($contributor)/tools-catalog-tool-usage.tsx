import { tv } from "tailwind-variants";

import CopyBlock from "@/components/copy-block";
import CopyCommand from "@/components/copy-command";
import { catalogService } from "@/services/catalog/catalog-service";
import type { CatalogCollection } from "@/services/catalog/catalog-types";
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

  if (collection.id === "edge-tts") {
    return (
      <div className={container()}>
        <div className={section()}>
          <p className={description()}>
            Call the TTS endpoint directly from terminal scripts, backend
            services, or coding agents to generate <code>.mp3</code> files
            without opening the UI.
          </p>

          <CopyCommand
            command={`curl -X POST '${siteOrigin}/api/tts' -H 'Content-Type: application/json' -d '{"text":"Hello world","voice":"en-US-AriaNeural"}' -o speech.mp3`}
          />
        </div>
      </div>
    );
  }

  if (collection.id === "download-reel") {
    return (
      <div className={container()}>
        <div className={section()}>
          <p className={description()}>
            Download public videos directly from terminal scripts, backend
            services, or coding agents using one shell command without opening
            the UI.
          </p>

          <CopyCommand
            command={`curl -fsSL ${catalogService.downloadReelScriptUrl(siteOrigin)} | bash -s -- --platform=tiktok --url='REEL_URL'`}
          />
        </div>
      </div>
    );
  }

  if (collection.id === "skills") {
    return (
      <div className={container()}>
        <div className={section()}>
          <p className={label()}>Use the skills</p>

          <p className={description()}>
            Download all, unzip it, copy each skill folder from{" "}
            <code>contributors/synasapmob/tools/skills/</code> into{" "}
            <code>~/.agents/skills</code>, and copy <code>rules/AGENTS.md</code>{" "}
            to <code>~/.agents/AGENTS.md</code>.
          </p>
        </div>

        <div className={section()}>
          <p className={description()}>
            Prefer a command? Link skills copies and links them for you, from
            Hub William or from this zip.
          </p>
        </div>
      </div>
    );
  }

  if (collection.id === "link-skills") {
    return (
      <div className={container()}>
        <div className={section()}>
          <p className={label()}>From Hub William</p>

          <p className={description()}>
            Fetches the skills from Hub William and installs them into{" "}
            <code>~/.agents</code>. Use it only if you trust Hub William, and
            read <code>link.sh</code> first.
          </p>

          <CopyCommand
            command={`curl -fsSL ${catalogService.linkSkillsScriptUrl("link.sh", siteOrigin)} | bash`}
          />
        </div>

        <div className={section()}>
          <p className={label()}>From your own copy</p>

          <p className={description()}>
            Download Skills and this tool, then point <code>link.sh</code> at
            the Skills zip, or at the folder you unzipped it into. Nothing is
            fetched. Without <code>--path</code> it uses Hub William.
          </p>

          <CopyCommand command="bash link.sh --path=~/Downloads/skills.zip" />
        </div>

        <div className={section()}>
          <p className={label()}>Remove</p>

          <p className={description()}>
            Removes the links and moves the installed skills to{" "}
            <code>~/.agents/.backups</code>. Your own skills stay where they
            are. Run <code>bash unlink.sh</code> from your own copy instead if
            you prefer.
          </p>

          <CopyCommand
            command={`curl -fsSL ${catalogService.linkSkillsScriptUrl("unlink.sh", siteOrigin)} | bash`}
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
