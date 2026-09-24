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
  };
  return labels[value.toLowerCase()] ?? value;
}

export function availabilityLabel(value: string) {
  const labels: Record<string, string> = {
    active: "Active",
    half_open: "Checking",
    rate_limited: "Rate limited",
    reauth_required: "Reconnect required",
  };
  return labels[value] ?? value;
}
