"""The TOML layer, on its own.

These run against the shapes actually found in `~/.codex/config.toml` and
`~/.grok/config.toml`: quoted keys with slashes, nested inline tables,
multi-line arrays, and comments that belong to the block below them.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib import tomlfile as T  # noqa: E402

CODEX = '''\
approvals_reviewer = "auto_review"
model = "gpt-5.6-sol"

[model_providers.hub]
name = "Hub William"
wire_api = "responses"

[otel]
environment = "production"
log_user_prompt = false
exporter = { otlp-http = { endpoint = "https://x/v1/logs", protocol = "json", headers = { Authorization = "Bearer abc" } } }

# codex required trust folder
[projects."/Users/me/Documents/personal/hub-william"]
trust_level = "trusted"

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"

[mcp_servers.chrome-devtools]
command = "npx"
args = [
    "-y",
    "chrome-devtools-mcp",
]

[hooks.state]

[hooks.state."/Users/me/.codex/hooks.json:session_start:0:0"]
trusted_hash = "sha256:deadbeef"
'''


class TestParsing(unittest.TestCase):
    def test_parses_a_realistic_config(self):
        data = T.load_data(CODEX)
        self.assertEqual(data["model"], "gpt-5.6-sol")
        self.assertEqual(data["mcp_servers"]["linear"]["url"],
                         "https://mcp.linear.app/mcp")
        self.assertEqual(data["mcp_servers"]["chrome-devtools"]["args"],
                         ["-y", "chrome-devtools-mcp"])
        self.assertEqual(data["otel"]["exporter"]["otlp-http"]["headers"]["Authorization"],
                         "Bearer abc")
        self.assertEqual(
            data["projects"]["/Users/me/Documents/personal/hub-william"]["trust_level"],
            "trusted",
        )
        self.assertIn("/Users/me/.codex/hooks.json:session_start:0:0",
                      data["hooks"]["state"])

    def test_scalars(self):
        data = T.load_data("\n".join([
            'a = "x"',
            "b = 12",
            "c = 1.5",
            "d = true",
            "e = false",
            "f = [1, 2, 3]",
            "g = 0x1f",
            "h = 1_000",
            'i = 2026-08-18T05:17:56Z',
            "j = { k = 1 }",
            "k = '''raw\nlines'''",
            'l = """multi\nline"""',
            "m = []",
        ]))
        self.assertEqual(data["a"], "x")
        self.assertEqual(data["b"], 12)
        self.assertEqual(data["c"], 1.5)
        self.assertIs(data["d"], True)
        self.assertIs(data["e"], False)
        self.assertEqual(data["f"], [1, 2, 3])
        self.assertEqual(data["g"], 31)
        self.assertEqual(data["h"], 1000)
        self.assertEqual(data["i"], "2026-08-18T05:17:56Z")
        self.assertEqual(data["j"], {"k": 1})
        self.assertEqual(data["k"], "raw\nlines")
        self.assertEqual(data["l"], "multi\nline")
        self.assertEqual(data["m"], [])

    def test_escapes_and_awkward_strings(self):
        data = T.load_data('\n'.join([
            r'a = "he said \"hi\""',
            r'b = "tab\there"',
            r'c = "é"',
            "d = 'no \\escape here'",
            'e = "# not a comment"',
            'f = "[not a header]"',
        ]))
        self.assertEqual(data["a"], 'he said "hi"')
        self.assertEqual(data["b"], "tab\there")
        self.assertEqual(data["c"], "é")
        self.assertEqual(data["d"], "no \\escape here")
        self.assertEqual(data["e"], "# not a comment")
        self.assertEqual(data["f"], "[not a header]")

    def test_array_of_tables(self):
        data = T.load_data("\n".join([
            "[[marketplace.sources]]",
            'name = "one"',
            "",
            "[[marketplace.sources]]",
            'name = "two"',
        ]))
        self.assertEqual([s["name"] for s in data["marketplace"]["sources"]],
                         ["one", "two"])

    def test_bad_input_raises_rather_than_guessing(self):
        for bad in ('a = "unterminated', "a = ", "[unclosed", "a = @nope"):
            with self.assertRaises(T.TomlError):
                T.load_data(bad)


class TestSurgicalEdits(unittest.TestCase):
    def test_upsert_touches_only_its_own_block(self):
        updated = T.upsert_table(
            CODEX, ("mcp_servers", "linear"),
            {"url": "https://mcp.linear.app/mcp"}, marker="mcp linear",
        )
        self.assertIn("# hub william machine: mcp linear", updated)
        for fragment in ('model = "gpt-5.6-sol"', "# codex required trust folder",
                         "[hooks.state]", "otlp-http", "chrome-devtools-mcp"):
            self.assertIn(fragment, updated)
        self.assertEqual(T.load_data(updated)["model"], "gpt-5.6-sol")

    def test_upsert_replaces_in_place(self):
        once = T.upsert_table(CODEX, ("mcp_servers", "linear"),
                              {"url": "https://a"}, marker="mcp linear")
        twice = T.upsert_table(once, ("mcp_servers", "linear"),
                               {"url": "https://b"}, marker="mcp linear")
        self.assertEqual(twice.count("[mcp_servers.linear]"), 1)
        self.assertEqual(twice.count("# hub william machine: mcp linear"), 1)
        self.assertEqual(T.load_data(twice)["mcp_servers"]["linear"]["url"], "https://b")

    def test_upsert_is_idempotent(self):
        once = T.upsert_table(CODEX, ("mcp_servers", "x"), {"url": "u"}, marker="mcp x")
        twice = T.upsert_table(once, ("mcp_servers", "x"), {"url": "u"}, marker="mcp x")
        self.assertEqual(once, twice)

    def test_append_to_an_empty_document(self):
        text = T.upsert_table("", ("mcp_servers", "x"), {"url": "u"})
        self.assertEqual(text, '[mcp_servers.x]\nurl = "u"\n')

    def test_remove_takes_the_marker_and_leaves_the_neighbours(self):
        with_block = T.upsert_table(CODEX, ("mcp_servers", "x"),
                                    {"url": "u"}, marker="mcp x")
        without = T.remove_table(with_block, ("mcp_servers", "x"))
        self.assertNotIn("[mcp_servers.x]", without)
        self.assertNotIn("hub william machine: mcp x", without)
        self.assertEqual(without, CODEX)

    def test_remove_keeps_a_comment_belonging_to_the_next_block(self):
        text = "\n".join([
            "[mcp_servers.a]",
            'url = "u"',
            "",
            "# this comment is about b",
            "[b]",
            "k = 1",
            "",
        ])
        without = T.remove_table(text, ("mcp_servers", "a"))
        self.assertIn("# this comment is about b", without)
        self.assertIn("[b]", without)
        self.assertNotIn("mcp_servers.a", without)

    def test_remove_of_a_missing_table_is_a_no_op(self):
        self.assertEqual(T.remove_table(CODEX, ("mcp_servers", "nope")), CODEX)

    def test_nested_env_becomes_a_subtable(self):
        text = T.upsert_table("", ("mcp_servers", "x"),
                              {"command": "npx", "args": ["-y"], "env": {"A": "1"}})
        data = T.load_data(text)
        self.assertEqual(data["mcp_servers"]["x"]["env"], {"A": "1"})
        self.assertEqual(data["mcp_servers"]["x"]["command"], "npx")

    def test_quoted_keys_round_trip(self):
        text = T.upsert_table("", ("projects", "/Users/me/a b"), {"trust_level": "t"})
        self.assertIn('[projects."/Users/me/a b"]', text)
        self.assertEqual(
            T.load_data(text)["projects"]["/Users/me/a b"]["trust_level"], "t"
        )

    def test_table_text_is_stable_for_fingerprints(self):
        text = T.upsert_table(CODEX, ("mcp_servers", "x"), {"url": "u"}, marker="mcp x")
        first = T.table_text(text, ("mcp_servers", "x"))
        again = T.upsert_table(text, ("mcp_servers", "x"), {"url": "u"}, marker="mcp x")
        self.assertEqual(first, T.table_text(again, ("mcp_servers", "x")))
        self.assertIn("hub william machine: mcp x", first)


if __name__ == "__main__":
    unittest.main()
