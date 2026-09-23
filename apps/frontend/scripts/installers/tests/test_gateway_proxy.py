"""Deployment proxy contracts for coding-agent gateway requests."""

import re
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[5]
NGINX_CONFIG = REPO_ROOT / "infra" / "nginx" / "default.conf.template"


class GatewayProxyTest(unittest.TestCase):
    def test_unlimited_body_handling_is_scoped_to_gateway_routes(self):
        document = NGINX_CONFIG.read_text(encoding="utf-8")
        gateway = re.search(
            r"location \^~ /api/gateway/ \{(?P<body>.*?)\n    \}",
            document,
            re.DOTALL,
        )
        browser_api = re.search(
            r"location /api/ \{(?P<body>.*?)\n    \}",
            document,
            re.DOTALL,
        )

        self.assertIsNotNone(gateway)
        self.assertIsNotNone(browser_api)
        self.assertIn("client_max_body_size 0;", gateway.group("body"))
        self.assertIn("proxy_pass $api_internal_url;", gateway.group("body"))
        self.assertNotIn("client_max_body_size", browser_api.group("body"))

    def test_playground_streaming_upload_limit_is_explicit(self):
        document = NGINX_CONFIG.read_text(encoding="utf-8")
        playground = re.search(r"location = /api/playground/chat \{(?P<body>.*?)\n    \}", document, re.DOTALL)
        self.assertIsNotNone(playground)
        body = playground.group("body")
        self.assertIn("client_max_body_size 32m;", body)
        self.assertIn("proxy_buffering off;", body)
        self.assertIn("proxy_read_timeout 300s;", body)
        self.assertIn("proxy_pass $api_internal_url;", body)


if __name__ == "__main__":
    unittest.main()
