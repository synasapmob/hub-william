export function formatCount(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatTokenCount(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
}

export function providerLabel(value: string) {
  const labels: Record<string, string> = {
    chatgpt: "ChatGPT",
    claude: "Claude",
    deepseek: "DeepSeek",
    gemini: "Gemini",
    grok: "Grok",
    groq: "Groq",
  };
  return labels[value.toLowerCase()] ?? value;
}

export function availabilityLabel(value: string) {
  return agentAvailabilityStatusLabel(value);
}
import { agentAvailabilityStatusLabel } from "@/utils/utils.agent-pools";

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}
