"""Deployment proxy contracts for coding-agent gateway requests."""

import re
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[5]
NGINX_CONFIG = REPO_ROOT / "infra" / "nginx" / "default.conf.template"
DASHBOARD_NGINX_CONFIG = REPO_ROOT / "infra" / "nginx" / "dashboard.conf.template"


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

    def test_catalog_markdown_is_served_as_text_not_a_download(self):
        document = NGINX_CONFIG.read_text(encoding="utf-8")
        catalog = re.search(
            r"location ~ \^/catalog/\.\+\\\.md\$ \{(?P<body>.*?)\n    \}",
            document,
            re.DOTALL,
        )

        self.assertIsNotNone(catalog)
        body = catalog.group("body")
        self.assertIn("text/markdown md;", body)
        self.assertIn("charset utf-8;", body)
        self.assertIn("charset_types text/markdown;", body)

    def test_catalog_scripts_are_served_as_text_not_a_download(self):
        document = NGINX_CONFIG.read_text(encoding="utf-8")
        catalog = re.search(
            r"location ~ \^/catalog/\.\+\\\.\(sh\|py\)\$ \{(?P<body>.*?)\n    \}",
            document,
            re.DOTALL,
        )

        self.assertIsNotNone(catalog)
        body = catalog.group("body")
        self.assertIn("text/plain sh py;", body)
        self.assertIn("charset utf-8;", body)

    def test_playground_streaming_upload_limit_is_explicit(self):
        document = NGINX_CONFIG.read_text(encoding="utf-8")
        playground = re.search(r"location = /api/playground/chat \{(?P<body>.*?)\n    \}", document, re.DOTALL)
        self.assertIsNotNone(playground)
        body = playground.group("body")
        self.assertIn("client_max_body_size 32m;", body)
        self.assertIn("proxy_buffering off;", body)
        self.assertIn("proxy_read_timeout 300s;", body)
        self.assertIn("proxy_pass $api_internal_url;", body)


class DashboardProxyTest(unittest.TestCase):
    def test_internal_routes_are_not_reachable_from_the_public_side(self):
        document = DASHBOARD_NGINX_CONFIG.read_text(encoding="utf-8")

        for location in ("= /api/internal", "^~ /api/internal/"):
            block = re.search(
                r"location " + re.escape(location) + r" \{(?P<body>.*?)\n    \}",
                document,
                re.DOTALL,
            )
            self.assertIsNotNone(block, location)
            self.assertIn("return 404;", block.group("body"))

    def test_api_is_proxied_on_the_dashboards_own_origin(self):
        document = DASHBOARD_NGINX_CONFIG.read_text(encoding="utf-8")
        browser_api = re.search(r"location /api/ \{(?P<body>.*?)\n    \}", document, re.DOTALL)

        self.assertIsNotNone(browser_api)
        body = browser_api.group("body")
        self.assertIn("rewrite ^/api/(.*)$ /$1 break;", body)
        self.assertIn("proxy_pass $api_internal_url;", body)
        self.assertNotIn("client_max_body_size", body)
        self.assertNotIn("/api/gateway/", document)

    def test_a_missing_asset_is_a_404_and_other_paths_fall_back_to_the_shell(self):
        document = DASHBOARD_NGINX_CONFIG.read_text(encoding="utf-8")
        assets = re.search(r"location \^~ /assets/ \{(?P<body>.*?)\n    \}", document, re.DOTALL)
        fallback = re.search(r"location / \{(?P<body>.*?)\n    \}", document, re.DOTALL)

        self.assertIsNotNone(assets)
        self.assertIn("try_files $uri =404;", assets.group("body"))
        self.assertIsNotNone(fallback)
        self.assertIn("try_files $uri /index.html;", fallback.group("body"))


if __name__ == "__main__":
    unittest.main()
