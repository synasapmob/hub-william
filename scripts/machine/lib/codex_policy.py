"""Compose an opted-in contributor policy with native Codex instructions.

Repository AGENTS.md and skill descriptions are user context. A native
developer instruction makes the operator's explicit workflow choice apply to
that context and to spawned agents, without rewriting repository files.
"""

from . import tomlfile

BEGIN = '<!-- hub-william:workflow begin -->'
END = '<!-- hub-william:workflow end -->'


def configure(text, policy, enabled):
    data = tomlfile.load_data(text)
    original = data.get('developer_instructions', '')
    if not isinstance(original, str):
        raise tomlfile.TomlError('developer_instructions must be a string')
    if original.count(BEGIN) != original.count(END) or original.count(BEGIN) > 1:
        raise tomlfile.TomlError('ambiguous Hub workflow policy markers')
    start = original.find(BEGIN)
    if start >= 0:
        end = original.find(END, start)
        if end < 0:
            raise tomlfile.TomlError('invalid Hub workflow policy marker order')
        # The separator is part of the managed block, not the user's text.
        prefix = original[:start]
        if prefix.endswith('\n\n'):
            prefix = prefix[:-2]
        remainder = prefix + original[end + len(END):]
    else:
        remainder = original
    if enabled:
        value = remainder + ('\n\n' if remainder else '') + BEGIN + '\n' + policy.strip() + '\n' + END
    else:
        if start < 0:
            return text
        value = remainder
    if value == original:
        return text
    if not value:
        return tomlfile.remove_root_value(text, 'developer_instructions')
    return tomlfile.upsert_root_value(text, 'developer_instructions', value)
