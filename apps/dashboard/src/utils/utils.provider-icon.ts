// The icons Hub William shows for its agents, by the agent's id. These are copies
// of `apps/frontend/public/assets/*-icon.*`: when Hub William changes one, copy it
// again.
const ICON_FILES: Record<string, string> = {
  chatgpt: "chatgpt-icon.png",
  claude: "claude-icon.png",
  deepseek: "deepseek-icon.png",
  gemini: "gemini-icon.svg",
  grok: "grok-icon.png",
  groq: "groq-icon.png",
};

/**
 * Where an agent's icon is, for a name written however the shop wrote it
 * ("ChatGPT", "chatgpt" and " Claude " all work). None for an agent Hub William
 * has no icon for.
 */
export function providerIconUrl(provider: string) {
  const file = ICON_FILES[provider.trim().toLowerCase()];

  return file ? `${import.meta.env.BASE_URL}assets/${file}` : null;
}
