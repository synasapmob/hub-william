import { Bot } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { AgentProvider } from "@/services/agent-pools";
import assetPath from "@/utils/utils.asset-path";

const agentIcons: Partial<Record<AgentProvider, string>> = {
  ChatGPT: assetPath("assets/chatgpt-icon.png"),
  Claude: assetPath("assets/claude-icon.png"),
  Gemini: assetPath("assets/gemini-icon.svg"),
  Grok: assetPath("assets/grok-icon.png"),
};

interface AgentsProviderIconProps {
  provider: AgentProvider;
}

export default function AgentsProviderIcon({
  provider,
}: AgentsProviderIconProps) {
  return (
    <Avatar size="sm" className="rounded-md after:rounded-md after:border-0">
      <AvatarImage
        src={agentIcons[provider]}
        alt=""
        className="rounded-md object-contain"
      />

      <AvatarFallback className="rounded-md bg-zinc-100 text-zinc-600">
        <Bot aria-hidden="true" className="size-4" />
      </AvatarFallback>
    </Avatar>
  );
}
