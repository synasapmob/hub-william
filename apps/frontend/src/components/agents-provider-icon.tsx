import { Bot } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { AgentProvider } from "@/services/agent/agent-types";
import { providerCatalogueService } from "@/services/provider-catalogue/provider-catalogue-service";
import type { ProviderId } from "@/services/provider-catalogue/provider-catalogue.generated";
import assetPath from "@/utils/utils.asset-path";

interface AgentsProviderIconProps {
  provider: AgentProvider | ProviderId;
}

export default function AgentsProviderIcon({
  provider,
}: AgentsProviderIconProps) {
  return (
    <Avatar size="sm" className="rounded-md after:rounded-md after:border-0">
      <AvatarImage
        src={assetPath(providerCatalogueService.byIdOrLabel(provider).icon)}
        alt=""
        className="rounded-md object-contain"
      />

      <AvatarFallback className="rounded-md bg-zinc-100 text-zinc-600">
        <Bot aria-hidden="true" className="size-4" />
      </AvatarFallback>
    </Avatar>
  );
}
