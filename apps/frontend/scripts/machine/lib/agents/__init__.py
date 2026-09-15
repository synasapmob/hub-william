"""The three harnesses this installer knows how to configure."""

AGENT_NAMES = ("claude", "codex", "grok")

_REGISTRY = None


def registry():
    global _REGISTRY
    if _REGISTRY is None:
        from .claude import ClaudeAgent
        from .codex import CodexAgent
        from .grok import GrokAgent
        _REGISTRY = {
            "claude": ClaudeAgent(),
            "codex": CodexAgent(),
            "grok": GrokAgent(),
        }
    return _REGISTRY


def get(name):
    return registry()[name]


def all_agents():
    return [registry()[name] for name in AGENT_NAMES]
