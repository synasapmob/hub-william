"""Exercise the job crawler against a fake browser page with made-up jobs, never the real sites."""

import contextlib
import csv
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import zipfile
from datetime import date, datetime, timedelta
from unittest import mock
from xml.etree import ElementTree


REPOSITORY = Path(__file__).resolve().parents[5]
SCRIPT = REPOSITORY / "contributors" / "synasapmob" / "tools" / "job-crawler" / "job-crawler.py"

spec = importlib.util.spec_from_file_location("job_crawler_tool", SCRIPT)
tool = importlib.util.module_from_spec(spec)
# The tool's folder is published as it is: a __pycache__ left beside the script would be
# bundled into the catalogue, so importing it here must not write bytecode.
write_bytecode = sys.dont_write_bytecode
sys.dont_write_bytecode = True
try:
    spec.loader.exec_module(tool)
finally:
    sys.dont_write_bytecode = write_bytecode

ITVIEC = tool.SOURCES["itviec"]
TOPCV = tool.SOURCES["topcv"]
real_chrome_problem = tool.chrome_problem  # the tests below replace it, as Chrome may not be installed
real_watch = tool.ChromeBridge._watch  # the tests below replace it: a thread must not give the focus away
real_connect_real_chrome = tool.connect_real_chrome  # the tests below replace it: none may drive the real Chrome


def card(title, url=None, **fields):
    return {
        "title": title,
        "url": "https://itviec.com/it-jobs/%s-1?lab_feature=preview#top" % title.lower().replace(" ", "-")
        if url is None
        else url,
        "company": "Acme Co",
        "tags": ["Rust", " Go "],
        **fields,
    }


class FakeResponse:
    def __init__(self, status):
        self.status = status


class FakeLocator:
    def __init__(self, count):
        self._count = count

    def count(self):
        return self._count


class FakePage:
    """Just enough of Playwright's page for the crawler: a site is a dict of address to state."""

    def __init__(self, site, search=None, closed=None, stuck_on=None):
        self.site = site
        self.search = search or {}
        self.closed = closed  # "goto" or "wait": the window is gone at that moment
        self.stuck_on = stuck_on  # an address the browser cannot leave
        self.url = stuck_on or ""
        self.state = {}
        self.visited = []
        self.typed = []
        self.closed_by_tool = False

    def close(self):
        self.closed_by_tool = True

    def goto(self, url, wait_until=None, timeout=None):
        if self.closed == "goto":
            raise Exception("Page.goto: Target page, context or browser has been closed")
        self.visited.append(url)
        if self.stuck_on:
            return FakeResponse(200)
        self.url = url
        self.state = self.site[url]
        return FakeResponse(self.state.get("status", 200))

    def locator(self, selector):
        if self.closed == "wait":
            raise Exception("Locator.count: Target page, context or browser has been closed")
        if "We cannot find" in selector:  # a page's own "no jobs" message
            return FakeLocator(1 if self.state.get("none") else 0)
        return FakeLocator(len(self.state.get("cards", [])))

    def title(self):
        return self.state.get("title", "")

    def evaluate(self, script):
        if "innerText" in script:
            return self.state.get("text", "")
        if script in {source.extract for source in tool.SOURCES.values()}:
            return self.state.get("cards", [])
        if script in {source.total_pages for source in tool.SOURCES.values() if source.total_pages}:
            return self.state.get("total_pages")
        if script in {source.next_page for source in tool.SOURCES.values()}:
            return self.state.get("next")
        raise AssertionError("unexpected script")

    def fill(self, selector, text):
        self.typed.append((selector, text))

    def press(self, selector, key):
        self.url = self.search[self.typed[-1][1]]
        self.state = self.site[self.url]

    def wait_for_url(self, predicate, timeout=None):
        assert predicate(self.url)

    def screenshot(self, path):
        Path(path).write_bytes(b"png")


class FakeContext:
    """A browser that opens a new fake window on every request; each window sees the same site."""

    def __init__(self, site):
        self.site = site
        self.windows = []
        self._lock = threading.Lock()

    def new_page(self):
        with self._lock:
            window = FakePage(self.site)
            self.windows.append(window)
            return window

    def close(self):
        pass


def options(*args, output_dir):
    return tool.parse_args(["--output-dir=%s" % output_dir, *args])


class JobCrawlerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for patcher in (
            mock.patch.object(tool.time, "sleep", lambda *_: None),
            mock.patch.object(tool, "RENDER_WAIT", 0.01),
            mock.patch.object(tool, "chrome_problem", lambda: ""),  # tests run where Chrome may not be installed
            mock.patch.object(tool.ChromeBridge, "_watch", lambda self, keep: None),  # no thread that moves the focus
            # On a Mac with Chrome the tool uses your Chrome unless told not to, so a test that reaches it by
            # accident must fail, not open windows on the machine that runs the tests.
            mock.patch.object(tool, "connect_real_chrome", side_effect=AssertionError("a test drove the real Chrome")),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def crawl(self, page, source, *args, context=None):
        jobs, seen, result = [], set(), tool.new_result()
        opts = options(*args, output_dir=self.root)
        with contextlib.redirect_stderr(io.StringIO()):
            tool.crawl_source(page, source, opts, jobs, seen, self.root / "run", result, context)
        return jobs, result

    def test_canonical_url_drops_tracking_and_trailing_slash(self):
        self.assertEqual(
            tool.canonical_url("https://ITviec.com/it-jobs/rust-dev-1/?lab_feature=x#top"),
            "https://itviec.com/it-jobs/rust-dev-1",
        )
        self.assertEqual(tool.canonical_url("javascript:alert(1)"), "")
        self.assertEqual(tool.canonical_url(""), "")

    def test_same_site_needs_https_and_the_exact_host(self):
        self.assertTrue(tool.same_site("https://itviec.com/it-jobs?page=2", "itviec.com"))
        self.assertFalse(tool.same_site("http://itviec.com/it-jobs", "itviec.com"))
        self.assertFalse(tool.same_site("https://itviec.com.evil.test/", "itviec.com"))

    def test_normalize_cleans_text_and_skips_cards_without_a_link(self):
        row = tool.normalize(
            card("  Rust\n Developer ", url="https://itviec.com/it-jobs/rust-dev-1?x=1", salary=" 20 - 30 triệu "),
            "itviec",
            "2026-11-27T00:00:00Z",
        )
        self.assertEqual(row["title"], "Rust Developer")
        self.assertEqual((row["salary"], row["salary_level"]), ("20 - 30 triệu", "20 - 30 triệu"))  # the text, then the level
        self.assertEqual(row["tags"], "Rust; Go")
        self.assertEqual(row["url"], "https://itviec.com/it-jobs/rust-dev-1")
        self.assertIsNone(tool.normalize(card("Rust", url=""), "itviec", "now"))
        self.assertIsNone(tool.normalize(card("  "), "itviec", "now"))

    def test_spreadsheet_safe_defuses_formulas_only(self):
        self.assertEqual(tool.spreadsheet_safe("=HYPERLINK(1)"), "'=HYPERLINK(1)")
        self.assertEqual(tool.spreadsheet_safe("+84 123"), "'+84 123")
        self.assertEqual(tool.spreadsheet_safe("20 - 30 triệu"), "20 - 30 triệu")
        self.assertEqual(tool.spreadsheet_safe(""), "")

    def test_csv_has_a_bom_the_columns_and_vietnamese_text(self):
        path = self.root / "jobs.csv"
        row = tool.normalize(card("Lập trình viên", company="Công ty ABC", url="https://www.topcv.vn/viec-lam/x/1.html"), "topcv", "now")
        tool.write_csv(path, [row])
        self.assertTrue(path.read_bytes().startswith(b"\xef\xbb\xbf"))
        with path.open(encoding="utf-8-sig") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(list(rows[0]), tool.COLUMNS)
        self.assertEqual(rows[0]["title"], "Lập trình viên")
        self.assertEqual(rows[0]["company"], "Công ty ABC")

    def test_classify_tells_a_check_from_a_block_from_a_missing_page(self):
        self.assertEqual(tool.classify("Just a moment...", "", 403), "challenge")
        self.assertEqual(tool.classify("", "Performing security verification", 200), "challenge")
        self.assertEqual(tool.classify("Attention Required! | Cloudflare", "", 403), "blocked")
        self.assertEqual(tool.classify("", "Sorry, you have been blocked", 403), "blocked")
        self.assertEqual(tool.classify("404 Not Found", "", 404), "not_found")
        self.assertEqual(tool.classify("", "", 429), "blocked")
        self.assertEqual(tool.classify("IT Jobs", "still drawing", 200), "pending")

    def test_arguments_are_checked(self):
        args = options(output_dir=self.root)
        self.assertEqual(args.sources, list(tool.SOURCES))
        self.assertEqual(options("--sources=TopCV, itviec,topcv", output_dir=self.root).sources, ["topcv", "itviec"])
        self.assertEqual(options("--keyword= react \n native ", output_dir=self.root).keyword, "react native")
        self.assertEqual(args.max_pages, 0)
        for bad in ("--sources=vietnamworks", "--max-pages=-1", "--max-pages=201", "--delay=0", "--keyword=a\x1bb"):
            with self.subTest(bad):
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                    options(bad, output_dir=self.root)
                self.assertEqual(raised.exception.code, 2)

    def test_two_pages_are_read_and_repeats_are_dropped(self):
        page_two = "https://itviec.com/it-jobs?page=2"
        page = FakePage(
            {
                "https://itviec.com/it-jobs": {"cards": [card("Rust Dev"), card("Go Dev")], "next": page_two},
                page_two: {"cards": [card("Go Dev"), card("Zig Dev")], "next": None},
            }
        )
        jobs, result = self.crawl(page, ITVIEC)
        self.assertEqual([job["title"] for job in jobs], ["Rust Dev", "Go Dev", "Zig Dev"])
        self.assertEqual((result["status"], result["pages"], result["jobs"], result["duplicates"]), ("ok", 2, 3, 1))
        self.assertFalse(result["more_pages"])
        self.assertEqual(page.visited, ["https://itviec.com/it-jobs", page_two])

    def test_it_stops_at_max_pages_and_says_there_are_more(self):
        page = FakePage(
            {
                "https://itviec.com/it-jobs": {"cards": [card("Rust Dev")], "next": "https://itviec.com/it-jobs?page=2"},
                "https://itviec.com/it-jobs?page=2": {"cards": [card("Go Dev")], "next": "https://itviec.com/it-jobs?page=3"},
            }
        )
        jobs, result = self.crawl(page, ITVIEC, "--max-pages=2")
        self.assertEqual(len(jobs), 2)
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["more_pages"])
        self.assertEqual(len(page.visited), 2)

    def test_every_page_is_read_by_default_and_a_safety_limit_still_applies(self):
        pages = {
            "https://itviec.com/it-jobs": {"cards": [card("Job 1")], "next": "https://itviec.com/it-jobs?page=2"},
            **{
                "https://itviec.com/it-jobs?page=%d" % number: {
                    "cards": [card("Job %d" % number)],
                    "next": "https://itviec.com/it-jobs?page=%d" % (number + 1) if number < 6 else None,
                }
                for number in range(2, 7)
            },
        }
        jobs, result = self.crawl(FakePage(pages), ITVIEC)
        self.assertEqual((len(jobs), result["pages"], result["more_pages"]), (6, 6, False))
        with mock.patch.object(tool, "MAX_PAGES", 4):
            jobs, result = self.crawl(FakePage(pages), ITVIEC)
        self.assertEqual((len(jobs), result["pages"], result["more_pages"]), (4, 4, True))
        self.assertIn("stopped after 4 pages", result["message"])

    def test_it_never_follows_a_next_link_to_another_site(self):
        page = FakePage(
            {"https://itviec.com/it-jobs": {"cards": [card("Rust Dev")], "next": "https://evil.test/it-jobs?page=2"}}
        )
        jobs, result = self.crawl(page, ITVIEC)
        self.assertEqual((len(jobs), result["pages"], result["status"]), (1, 1, "ok"))
        self.assertEqual(page.visited, ["https://itviec.com/it-jobs"])

    def test_the_keyword_goes_in_the_itviec_address(self):
        url = "https://itviec.com/it-jobs?query=c%2B%2B+dev"
        page = FakePage({url: {"cards": [card("C++ Dev")], "next": None}})
        jobs, _ = self.crawl(page, ITVIEC, "--keyword=c++ dev")
        self.assertEqual(len(jobs), 1)
        self.assertEqual(page.visited, [url])

    def test_the_keyword_is_typed_into_the_topcv_search_box(self):
        start = TOPCV.start_url("")
        found = "https://www.topcv.vn/tim-viec-lam-python-kcr257"
        row = card("Python Dev", url="https://www.topcv.vn/viec-lam/python-dev/9.html")
        page = FakePage(
            {start: {"cards": [card("Sales", url="https://www.topcv.vn/viec-lam/sales/1.html")]}, found: {"cards": [row]}},
            search={"python": found},
        )
        jobs, result = self.crawl(page, TOPCV, "--keyword=python")
        self.assertEqual(page.typed, [("#keyword", "python")])
        self.assertEqual([job["title"] for job in jobs], ["Python Dev"])
        self.assertEqual(result["status"], "ok")

    def test_a_human_check_ends_the_site_when_headless_and_keeps_earlier_pages(self):
        page_two = "https://itviec.com/it-jobs?page=2"
        page = FakePage(
            {
                "https://itviec.com/it-jobs": {"cards": [card("Rust Dev")], "next": page_two},
                page_two: {"status": 403, "title": "Just a moment...", "cards": []},
            }
        )
        jobs, result = self.crawl(page, ITVIEC, "--headless")
        self.assertEqual(len(jobs), 1)
        self.assertEqual((result["status"], result["pages"]), ("challenge", 1))
        self.assertIn("--headless", result["message"])
        self.assertTrue((self.root / "run" / "screenshots" / "itviec-page2-challenge.png").exists())

    def test_a_human_check_waits_then_gives_up(self):
        page = FakePage({"https://itviec.com/it-jobs": {"status": 403, "title": "Just a moment...", "cards": []}})
        with mock.patch.object(tool.time, "monotonic", side_effect=[0, 0, 1, 2, 3, 400, 400, 400]):
            jobs, result = self.crawl(page, ITVIEC, "--challenge-wait=10")
        self.assertEqual((jobs, result["status"]), ([], "challenge"))
        self.assertIn("not completed within 10 s", result["message"])

    def test_a_block_a_404_an_empty_page_and_changed_markup_are_told_apart(self):
        cases = {
            "blocked": {"status": 403, "title": "Attention Required! | Cloudflare", "cards": []},
            "not_found": {"status": 404, "title": "404 Not Found", "cards": []},
            "empty": {"status": 200, "title": "IT Jobs", "text": "nothing yet", "cards": []},
            "unreadable": {"status": 200, "title": "IT Jobs", "cards": [{"title": "", "url": ""}]},
        }
        for status, state in cases.items():
            with self.subTest(status):
                page = FakePage({"https://itviec.com/it-jobs": state})
                jobs, result = self.crawl(page, ITVIEC)
                self.assertEqual((jobs, result["status"]), ([], status))

    def test_matching_ignores_case_and_accents_and_any_listed_value_will_do(self):
        row = {"company": "Công ty ABC", "location": "Hồ Chí Minh (mới)"}
        opts = options("--company=cong ty abc", "--location=Ha Noi, ho chi minh", output_dir=self.root)
        self.assertTrue(tool.matches(row, opts))
        self.assertFalse(tool.matches(row, options("--company=xyz", output_dir=self.root)))
        self.assertFalse(tool.matches(row, options("--company=abc", "--location=Da Nang", output_dir=self.root)))
        self.assertTrue(tool.matches(row, options(output_dir=self.root)))
        self.assertEqual(tool.fold("Đà Nẵng"), "da nang")

    def test_company_and_location_terms_are_checked(self):
        self.assertEqual(options("--company= MB Bank , Techcombank,", output_dir=self.root).company, ["MB Bank", "Techcombank"])
        for bad in ("--company=,,", "--location=" + ",".join("x" * 11), "--company=a\x1bb"):
            with self.subTest(bad):
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                    options(bad, output_dir=self.root)
                self.assertEqual(raised.exception.code, 2)

    def test_a_single_company_is_searched_on_itviec_and_filtered_everywhere(self):
        url = "https://itviec.com/it-jobs?query=MB+Bank"
        page = FakePage(
            {
                url: {
                    "cards": [
                        card("Java Dev", company="MB Bank", location="Ha Noi"),
                        card("Go Dev", company="MB Bank", location="Ho Chi Minh"),
                        card("Rust Dev", company="Other Co", location="Ha Noi"),
                    ]
                }
            }
        )
        jobs, result = self.crawl(page, ITVIEC, "--company=MB Bank", "--location=ha noi")
        self.assertEqual([job["title"] for job in jobs], ["Java Dev"])
        self.assertEqual((result["jobs"], result["filtered_out"]), (1, 2))
        self.assertEqual(page.visited, [url])

    def test_topcv_is_not_searched_for_a_company_only_filtered(self):
        start = TOPCV.start_url("")
        row = card("Java Dev", url="https://www.topcv.vn/viec-lam/java/1.html", company="Ngân hàng MB")
        other = card("Sales", url="https://www.topcv.vn/viec-lam/sales/2.html", company="Other Co")
        page = FakePage({start: {"cards": [row, other]}})
        jobs, result = self.crawl(page, TOPCV, "--company=ngan hang mb")
        self.assertEqual(page.typed, [])
        self.assertEqual([job["title"] for job in jobs], ["Java Dev"])
        self.assertEqual(result["filtered_out"], 1)

    def test_each_company_is_searched_on_its_own_and_unknown_ones_are_listed(self):
        search = "https://itviec.com/it-jobs?query=%s"
        page = FakePage(
            {
                search % "MB+Bank": {"cards": [card("Java Dev", company="MB Bank"), card("Go Dev", company="MB Bank")]},
                # a company the site does not have: the word matches other companies' jobs
                search % "Google": {"cards": [card("Rust Dev", company="Acme Co")]},
                search % "Meta": {"cards": []},
                search % "VinSmart+Future": {"cards": [card("Go Dev", company="MB Bank"), card("QA", company="VinSmart Future")]},
            }
        )
        jobs, result = self.crawl(page, ITVIEC, "--company=MB Bank, Google, Meta, VinSmart Future")
        self.assertEqual(sorted(job["title"] for job in jobs), ["Go Dev", "Java Dev", "QA"])
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["no_jobs_for"], ["Google", "Meta"])
        self.assertIn("no matching jobs for: Google, Meta", result["message"])
        self.assertEqual(len(page.visited), 4)
        self.assertEqual(result["duplicates"], 1)  # MB Bank's Go Dev showed up in a second search

    def test_a_site_that_cannot_search_companies_is_read_once_and_filtered(self):
        self.assertEqual(tool.search_terms(TOPCV, options("--company=MB Bank, Google", output_dir=self.root)), [""])
        self.assertEqual(
            tool.search_terms(ITVIEC, options("--company=MB Bank, Google", output_dir=self.root)), ["MB Bank", "Google"])
        self.assertEqual(
            tool.search_terms(ITVIEC, options("--company=MB Bank", "--keyword=java", output_dir=self.root)), ["java"])
        self.assertEqual(tool.search_terms(ITVIEC, options(output_dir=self.root)), [""])

    def test_a_filter_that_removes_everything_says_so(self):
        page = FakePage({"https://itviec.com/it-jobs": {"cards": [card("Rust Dev", company="Acme Co")]}})
        jobs, result = self.crawl(page, ITVIEC, "--location=Da Nang")
        self.assertEqual((jobs, result["status"], result["filtered_out"]), ([], "ok", 1))
        self.assertIn("none matched the filters", result["message"])

    def test_the_source_column_names_the_site(self):
        page = FakePage({"https://itviec.com/it-jobs": {"cards": [card("Rust Dev")]}})
        jobs, _ = self.crawl(page, ITVIEC)
        self.assertEqual(jobs[0]["source"], "ITviec")
        self.assertEqual(tool.SOURCES["careerviet"].label, "CareerViet")

    def test_careerviet_addresses_cover_the_it_category_and_keyword_pages(self):
        self.assertEqual(
            tool.careerviet_start(""), "https://careerviet.vn/viec-lam/cntt-phan-mem-c1-vi.html")
        self.assertEqual(
            tool.careerviet_start("vietcombank"), "https://careerviet.vn/viec-lam/vietcombank-k-vi.html")
        self.assertEqual(
            tool.careerviet_start(" Thiết kế  nội thất "),
            "https://careerviet.vn/viec-lam/Thi%E1%BA%BFt-k%E1%BA%BF-n%E1%BB%99i-th%E1%BA%A5t-k-vi.html")

    def test_the_spreadsheet_links_each_title_and_has_no_url_column(self):
        main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        package = "http://schemas.openxmlformats.org/package/2006/relationships"
        first = tool.normalize(
            card("R&D <Lead>", company="A\x01B", url="https://itviec.com/it-jobs/a&b-1?x=1"), "itviec", "now")
        second = tool.normalize(card("Go Dev", url="https://itviec.com/it-jobs/go-2"), "itviec", "now")
        path = self.root / "jobs.xlsx"
        tool.write_xlsx(path, [first, second])
        with zipfile.ZipFile(path) as archive:
            self.assertIsNone(archive.testzip())
            parts = {name: ElementTree.fromstring(archive.read(name)) for name in archive.namelist()}
        sheet = parts["xl/worksheets/sheet1.xml"]
        rows = [[("".join(cell.itertext()), cell.get("r")) for cell in row] for row in sheet.iter("{%s}row" % main)]
        self.assertEqual([text for text, _ in rows[0]], tool.SHEET_COLUMNS)
        self.assertNotIn("url", tool.SHEET_COLUMNS)
        letter = lambda name: chr(ord("A") + tool.SHEET_COLUMNS.index(name))  # noqa: E731
        cells = {ref: text for text, ref in rows[1]}  # empty cells are not written, so look up by reference
        self.assertEqual(cells[letter("title") + "2"], "R&D <Lead>")
        self.assertEqual(cells[letter("company") + "2"], "AB")
        targets = {
            rel.get("Id"): rel.get("Target") for rel in parts["xl/worksheets/_rels/sheet1.xml.rels"].iter("{%s}Relationship" % package)
        }
        links = {
            link.get("ref"): targets[link.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")]
            for link in sheet.iter("{%s}hyperlink" % main)
        }
        title = letter("title")
        self.assertEqual(links, {title + "2": "https://itviec.com/it-jobs/a&b-1", title + "3": "https://itviec.com/it-jobs/go-2"})
        self.assertEqual(sheet.find(".//{%s}pane" % main).get("state"), "frozen")
        self.assertEqual(sheet.find("{%s}autoFilter" % main).get("ref"), "A1:%s3" % chr(ord("A") + len(tool.SHEET_COLUMNS) - 1))
        for left_out in ("tags", "scraped_at"):
            self.assertNotIn(left_out, tool.COLUMNS)
            self.assertNotIn(left_out, [text for text, _ in rows[0]])
        self.assertIn("tags", first)  # still kept on the row, for --keyword on a company page

    def sheet_header_and_csv_header(self, jobs):
        main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        tool.write_xlsx(self.root / "jobs.xlsx", jobs)
        tool.write_csv(self.root / "jobs.csv", jobs)
        with zipfile.ZipFile(self.root / "jobs.xlsx") as archive:
            sheet = ElementTree.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        header = ["".join(cell.itertext()) for cell in next(sheet.iter("{%s}row" % main))]
        with (self.root / "jobs.csv").open(encoding="utf-8-sig") as handle:
            return header, next(csv.reader(handle))

    def test_a_salary_is_ordered_by_its_top_amount_in_millions_of_dong(self):
        for written, amount in (
            ("10 - 15 triệu", 15.0),
            ("9 - 12 triệu", 12.0),
            ("1.5 - 2 triệu", 2.0),
            ("3 - 3,5 Triệu VND", 3.5),  # a decimal comma
            ("Tới 45 triệu", 45.0),
            ("Lên đến 45 Triệu VND", 45.0),
            ("Từ 3 triệu", 3.0),
            ("1,000 - 2,000 USD", 50.0),  # thousands, and dollars at 25,000 dong
            ("500 - 1,000 USD", 25.0),
            ("Up to $2,000", 50.0),
            ("15,000,000 - 25,000,000 VND", 25.0),  # dong written in full
            ("15.000.000 VND", 15.0),
            ("Thoả thuận", 0.0),  # no amount in it: apart from the ones that have one
            ("Competitive", 0.0),
            ("Very attractive!!!", 0.0),
            ("", None),
        ):
            with self.subTest(written):
                self.assertEqual(tool.salary_amount(written), amount)
        order = ["Thoả thuận", "9 - 12 triệu", "10 - 15 triệu", "Tới 45 triệu", "1,000 - 2,000 USD"]
        self.assertEqual(sorted(order[::-1], key=tool.salary_amount), order)  # ascending, dollars among the dong

    def test_experience_is_ordered_by_the_years_it_asks_for(self):
        for written, years in (
            ("Entry-level", 0.0), ("Under 1 year", 0.5), ("1 year", 1.0), ("2 years", 2.0), ("4 years", 4.0),
            ("4-5 years", 4.5), ("5 years", 5.0), ("5+ years", 5.25), ("1.5 years", 1.5), ("Senior", None), ("", None),
        ):
            with self.subTest(written):
                self.assertEqual(tool.experience_years(written), years)
        order = ["Entry-level", "Under 1 year", "1 year", "3 years", "4-5 years", "5 years", "5+ years"]
        self.assertEqual(sorted(order[::-1], key=tool.experience_years), order)

    def test_a_salary_is_one_of_a_few_levels_and_a_number_to_sort_by(self):
        for written, level in (
            ("10 - 15 triệu", ("10 - 20 triệu", 15.0)),
            ("10 - 15 Triệu VND", ("10 - 20 triệu", 15.0)),  # the same salary written two ways: one entry
            ("12 - 15 triệu", ("10 - 20 triệu", 15.0)),
            ("20 - 30 triệu", ("20 - 30 triệu", 30.0)),  # a top amount of exactly 30 is in "20 - 30"
            ("10 - 30 triệu", ("20 - 30 triệu", 30.0)),
            ("Tới 2 triệu", ("Up to 10 triệu", 2.0)),
            ("Tới 10 triệu", ("Up to 10 triệu", 10.0)),
            ("Từ 3 triệu", ("Up to 10 triệu", 3.0)),
            ("3 - 3,5 Triệu VND", ("Up to 10 triệu", 3.5)),
            ("Lên đến 45 Triệu VND", ("30 - 50 triệu", 45.0)),
            ("25 - 40 triệu", ("30 - 50 triệu", 40.0)),
            ("1,000 - 2,000 USD", ("30 - 50 triệu", 50.0)),  # dollars at 25,000 dong
            ("2,000 - 5,000 USD", ("Over 100 triệu", 125.0)),
            ("Up to $2,000", ("30 - 50 triệu", 50.0)),
            ("500 - 1,000 USD", ("20 - 30 triệu", 25.0)),
            ("15,000,000 - 25,000,000 VND", ("20 - 30 triệu", 25.0)),
            ("60 - 80 triệu", ("50 - 100 triệu", 80.0)),
            # no amount in it: a level of its own, and below every amount
            ("Thoả thuận", ("Thoả thuận", -1.0)),
            ("Thỏa thuận", ("Thoả thuận", -1.0)),  # the same word with the accent on another letter
            ("Negotiable", ("Thoả thuận", -1.0)),
            ("Let's discuss", ("Thoả thuận", -1.0)),
            ("Cạnh tranh", ("Cạnh tranh", -2.0)),
            ("Competitive", ("Cạnh tranh", -2.0)),
            ("Attractive salary!", ("Cạnh tranh", -2.0)),
            ("Very attractive!!!", ("Cạnh tranh", -2.0)),
            ("High paid job", ("Cạnh tranh", -2.0)),
            ("Không lương", ("Không lương", -3.0)),
            ("Mức lương: tuỳ kinh nghiệm", ("Khác", -4.0)),
        ):
            with self.subTest(written):
                self.assertEqual(tool.salary_level(written), level)
        self.assertIsNone(tool.salary_level(""))
        # lowest first and highest first are the order of the numbers
        order = ["Thoả thuận", "Tới 2 triệu", "10 - 15 triệu", "20 - 30 triệu", "1,000 - 2,000 USD", "2,000 - 5,000 USD"]
        self.assertEqual(sorted(order[::-1], key=lambda written: tool.salary_level(written)[1]), order)

    def test_the_salary_column_has_only_a_few_entries_however_many_different_salaries_there_are(self):
        salaries = ["%d - %d USD" % (500 + number, 900 + number * 3) for number in range(300)]
        salaries += ["%d - %d triệu" % (number, number + 5) for number in range(1, 80)]
        salaries += ["Thoả thuận", "Thỏa thuận", "Negotiable", "Cạnh tranh", "Competitive", "Very attractive!!!", "Không lương"]
        rows = [tool.normalize(card("Backend Developer %d" % number, company="Acme", salary=salary), "ITviec", "now",
                               now=datetime(2026, 11, 27)) for number, salary in enumerate(salaries)]
        self.assertLessEqual(len({row["salary_level"] for row in rows}), len(tool.SALARY_LEVELS) + 5)  # levels + the words
        cells = self.sheet_cells(rows)
        header = {cells["%s1" % letter][1]: letter for letter in "ABCDEFGHIJ" if "%s1" % letter in cells}
        self.assertNotIn("salary_detail", header)  # one salary column
        salary = header["salary"]
        shown = {cells["%s%d" % (salary, row)][2] for row in range(2, len(rows) + 2)}
        self.assertLessEqual(len(shown), len(tool.SALARY_LEVELS) + 5)  # what the filter list holds
        # the CSV keeps what the sites wrote
        tool.write_csv(self.root / "levels.csv", rows)
        with (self.root / "levels.csv").open(encoding="utf-8-sig") as handle:
            written = list(csv.DictReader(handle))
        self.assertNotIn("salary_detail", written[0])
        self.assertEqual([row["salary"] for row in written[:2]], ["500 - 900 USD", "501 - 903 USD"])
        self.assertEqual(written[-1]["salary"], "Không lương")

    def sheet_cells(self, jobs, **patched):
        """The sheet's cells by reference, as (type, value text, number format code or None), after writing it."""
        main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        tool.write_xlsx(self.root / "typed.xlsx", jobs)
        with zipfile.ZipFile(self.root / "typed.xlsx") as archive:
            sheet = ElementTree.fromstring(archive.read("xl/worksheets/sheet1.xml"))
            styles = ElementTree.fromstring(archive.read("xl/styles.xml"))
        codes = {int(node.get("numFmtId")): node.get("formatCode") for node in styles.iter("{%s}numFmt" % main)}
        formats = [codes.get(int(xf.get("numFmtId"))) for xf in styles.find("{%s}cellXfs" % main)]
        self.assertEqual(int(styles.find("{%s}cellXfs" % main).get("count")), len(formats))
        cells = {}
        for cell in sheet.iter("{%s}c" % main):
            cells[cell.get("r")] = (cell.get("t"), "".join(cell.itertext()), formats[int(cell.get("s", "0"))])
        return cells

    def test_posted_experience_and_salary_are_cells_a_spreadsheet_can_sort_and_still_show_the_text(self):
        now = datetime(2026, 11, 27, 9, 0)
        rows = [
            tool.normalize(card("Backend Developer", company="Acme", posted="Posted 2 days ago", experience="2 năm",
                                salary="10 - 15 Triệu VND"), "ITviec", "now", now=now),
            tool.normalize(card("Backend Engineer", company="Beta", posted="Cập nhật: 20-11-2026", experience="Trên 5 năm",
                                salary="Thoả thuận"), "CareerViet", "now", now=now),
            tool.normalize(card("Backend Dev", company="Gamma", posted="Closing soon", experience="Senior", salary=""),
                           "TopCV", "now", now=now),
        ]
        cells = self.sheet_cells(tool.sort_jobs(rows))
        header = {cells["%s1" % letter][1]: letter for letter in "ABCDEFGHIJ" if "%s1" % letter in cells}
        posted, experience, salary = header["posted"], header["experience"], header["salary"]
        serial = lambda day: str((day - tool.EXCEL_EPOCH).days)  # noqa: E731
        self.assertEqual((tool.EXCEL_EPOCH + (date(2000, 1, 1) - tool.EXCEL_EPOCH)).year, 2000)
        self.assertEqual((date(2000, 1, 1) - tool.EXCEL_EPOCH).days, 36526)  # Excel's own number for 1 Jan 2000
        # a date, shown as "Created at 25-11-2026" or "Edited at 20-11-2026"
        self.assertEqual(cells[posted + "2"], (None, serial(date(2026, 11, 25)), '"Created at "dd-mm-yyyy'))
        self.assertEqual(cells[posted + "3"], (None, serial(date(2026, 11, 20)), '"Edited at "dd-mm-yyyy'))
        # text with no date in it stays text
        self.assertEqual(cells[posted + "4"][0:2], ("inlineStr", "Closing soon"))
        # experience: the years as a number, shown as the text it was
        self.assertEqual(cells[experience + "2"], (None, "2.0", '"2 years"'))
        self.assertEqual(cells[experience + "3"], (None, "5.25", '"5+ years"'))
        self.assertEqual(cells[experience + "4"][0:2], ("inlineStr", "Senior"))
        # salary: the top amount as a number, shown as its level; no salary, no cell
        self.assertEqual(cells[salary + "2"], (None, "15.0", '"10 - 20 triệu";"10 - 20 triệu"'))
        # a level with no amount is a negative number, and its second format section keeps the minus sign off
        self.assertEqual(cells[salary + "3"], (None, "-1.0", '"Thoả thuận";"Thoả thuận"'))
        self.assertNotIn(salary + "4", cells)
        # the CSV keeps the text, for people and programs that read it as text
        tool.write_csv(self.root / "typed.csv", tool.sort_jobs(rows))
        with (self.root / "typed.csv").open(encoding="utf-8-sig") as handle:
            written = list(csv.DictReader(handle))
        self.assertEqual(
            [(row["posted"], row["experience"], row["salary"]) for row in written],
            [("Created at 25-11-2026", "2 years", "10 - 15 Triệu VND"), ("Edited at 20-11-2026", "5+ years", "Thoả thuận"),
             ("Closing soon", "Senior", "")])  # the CSV has the salary as the site wrote it

    def test_two_jobs_with_the_same_text_share_one_cell_format(self):
        rows = [tool.normalize(card("Backend Developer %d" % number, company="Acme", salary="%d - 15 triệu" % (5 + number % 3),
                                    experience="2 năm"), "ITviec", "now", now=datetime(2026, 11, 27)) for number in range(20)]
        cells = self.sheet_cells(rows)
        header = {cells["%s1" % letter][1]: letter for letter in "ABCDEFGHIJ" if "%s1" % letter in cells}
        for name, expected in (("salary", '"10 - 20 triệu";"10 - 20 triệu"'), ("experience", '"2 years"')):
            shown = {cells["%s%d" % (header[name], row)][2] for row in range(2, 22)}
            self.assertEqual(shown, {expected})

    def test_a_workbook_with_more_display_formats_than_allowed_writes_the_rest_as_plain_text(self):
        rows = [tool.normalize(card("Backend Developer %d" % number, company="Acme", experience="%d years" % number),
                               "ITviec", "now", now=datetime(2026, 11, 27)) for number in range(1, 6)]
        with mock.patch.object(tool, "MAX_NUMBER_FORMATS", 3):
            cells = self.sheet_cells(rows)
        header = {cells["%s1" % letter][1]: letter for letter in "ABCDEFGHIJ" if "%s1" % letter in cells}
        kinds = [cells["%s%d" % (header["experience"], row)][0] for row in range(2, 7)]
        self.assertEqual(kinds, [None, None, None, "inlineStr", "inlineStr"])  # three formats, then plain text
        self.assertEqual(cells["%s5" % header["experience"]][1], "4 years")  # still shown right
        self.assertIsNone(tool.literal_format("x" * 300))  # a number format holds 255 characters
        self.assertEqual(tool.literal_format('say "hi"'), "\"say 'hi'\"")  # and has no room for a quote inside

    def test_the_source_column_is_left_out_when_it_only_repeats_the_company(self):
        # a company's own career page: the source is the company
        own = [tool.normalize(card("Rust Dev", company="Symbotic"), "Symbotic", "now")]
        header, csv_header = self.sheet_header_and_csv_header(own)
        self.assertNotIn("source", header)
        self.assertNotIn("source", csv_header)
        self.assertEqual(header, [name for name in tool.SHEET_COLUMNS if name != "source"])
        self.assertEqual(csv_header, [name for name in tool.COLUMNS if name != "source"])

    def test_the_source_column_stays_when_a_job_board_is_in_the_run(self):
        mixed = [
            tool.normalize(card("Rust Dev", company="Symbotic"), "Symbotic", "now"),
            tool.normalize(card("Go Dev", company="MB Bank"), "CareerViet", "now"),
        ]
        header, csv_header = self.sheet_header_and_csv_header(mixed)
        self.assertEqual(header, tool.SHEET_COLUMNS)
        self.assertEqual(csv_header, tool.COLUMNS)

    def test_an_empty_spreadsheet_is_still_a_valid_workbook(self):
        path = self.root / "jobs.xlsx"
        tool.write_xlsx(path, [])
        with zipfile.ZipFile(path) as archive:
            for name in archive.namelist():
                ElementTree.fromstring(archive.read(name))
            self.assertNotIn("xl/worksheets/_rels/sheet1.xml.rels", archive.namelist())

    def test_canonical_url_keeps_an_id_parameter_but_no_tracking(self):
        self.assertEqual(
            tool.canonical_url("https://www.worldquant.com/career-listing/?id=4687291006&utm_source=x#top"),
            "https://www.worldquant.com/career-listing?id=4687291006",
        )
        self.assertEqual(tool.canonical_url("https://itviec.com/it-jobs/a-1?lab_feature=x"), "https://itviec.com/it-jobs/a-1")

    def test_jobs_at_one_address_with_different_titles_are_all_kept(self):
        # Topicus and Lecle point every title at the same careers page
        page = FakePage(
            {
                "https://www.topicus.vn/careers": {
                    "cards": [
                        card("Product Owner", url="https://www.topicus.vn/careers", company="Topicus Vietnam"),
                        card("Automation Tester", url="https://www.topicus.vn/careers", company="Topicus Vietnam"),
                        card("Automation Tester", url="https://www.topicus.vn/careers", company="Topicus Vietnam"),
                    ]
                }
            }
        )
        jobs, result = self.crawl(page, tool.SOURCES["topicus"])
        self.assertEqual([job["title"] for job in jobs], ["Product Owner", "Automation Tester"])
        self.assertEqual(result["duplicates"], 1)

    def test_ho_chi_minh_matches_in_every_spelling_and_remote_may_be_a_work_model(self):
        opts = options("--location=Ho Chi Minh City, Remote", output_dir=self.root)

        def row(location, work_model=""):
            return {"company": "Acme", "location": location, "work_model": work_model}

        for place in ("Ho Chi Minh", "Hồ Chí Minh (mới)", "VNM Ho Chi Minh", "Hanoi or Ho Chi Minh City, Vietnam", "TP.HCM", "Saigon"):
            with self.subTest(place):
                self.assertTrue(tool.matches(row(place), opts))
        self.assertTrue(tool.matches(row("Ha Noi", "Remote"), opts))  # ITviec's work model
        self.assertTrue(tool.matches(row("USA Remote & Travel"), opts))
        self.assertTrue(tool.matches(row("Vietnam-Remote"), opts))  # Axon's own spelling
        for place in ("Ha Noi", "Vietnam", "Da Nang", "Singapore"):
            with self.subTest("not " + place):
                self.assertFalse(tool.matches(row(place, "At office"), opts))
        self.assertTrue(tool.matches(row("Vietnam"), options("--location=Vietnam", output_dir=self.root)))

    def test_posted_is_a_created_or_edited_date_in_one_format(self):
        now = datetime(2026, 11, 27, 10, 0)
        for written, shown in (
            ("Posted 31 minutes ago", "Created at 27-11-2026"),  # ITviec
            ("Posted an hour ago", "Created at 27-11-2026"),
            ("Posted 2 days ago", "Created at 25-11-2026"),
            ("Posted 1 week ago", "Created at 20-11-2026"),
            ("Đăng 3 giờ trước", "Created at 27-11-2026"),  # TopCV
            ("Đăng 1 ngày trước", "Created at 26-11-2026"),
            ("Đăng 1 tuần trước", "Created at 20-11-2026"),
            ("Đăng 1 tháng trước", "Created at 28-10-2026"),
            ("Cập nhật: 27-11-2026", "Edited at 27-11-2026"),  # CareerViet says "updated"
            ("Nov 25, 2026", "Created at 25-11-2026"),  # Topicus
            ("Dec 3, 2025", "Created at 03-12-2025"),
            ("30-10-2026", "Created at 30-10-2026"),
            ("Updated 5-1-2026", "Edited at 05-01-2026"),
            ("", ""),
            ("Closing soon", "Closing soon"),  # nothing to read as a date: left as written
            ("Cập nhật: 31-02-2026", "Cập nhật: 31-02-2026"),  # a date that does not exist
        ):
            with self.subTest(written):
                self.assertEqual(tool.format_posted(written, now), shown)
        # an age that crosses midnight lands on the day before
        self.assertEqual(tool.format_posted("Posted 3 hours ago", datetime(2026, 11, 27, 1, 0)), "Created at 26-11-2026")

    def test_a_card_gets_its_posted_date_when_it_is_read(self):
        row = tool.normalize(card("Rust Dev", posted="Cập nhật: 27-11-2026"), "CareerViet", "now", now=datetime(2026, 11, 27, 9, 0))
        self.assertEqual(row["posted"], "Edited at 27-11-2026")

    def test_a_card_keeps_its_posted_day_as_a_date_for_the_date_filter(self):
        now = datetime(2026, 11, 27, 9, 0)
        for written, day in (
            ("Cập nhật: 27-11-2026", date(2026, 11, 27)),
            ("Đăng 2 tuần trước", date(2026, 11, 13)),
            ("Posted 3 days ago", date(2026, 11, 24)),
            ("Nov 25, 2026", date(2026, 11, 25)),
            ("", None),
            ("Closing soon", None),
            ("Cập nhật: 31-02-2026", None),
        ):
            with self.subTest(written):
                self.assertEqual(tool.normalize(card("Rust Dev", posted=written), "x", "now", now=now)["posted_on"], day)

    def test_date_keeps_the_jobs_posted_in_the_last_days_and_those_with_no_date(self):
        today = date(2026, 11, 27)
        self.assertTrue(tool.posted_within({"posted_on": date(2026, 10, 28)}, 30, today))  # exactly 30 days ago
        self.assertFalse(tool.posted_within({"posted_on": date(2026, 10, 27)}, 30, today))  # 31 days ago
        self.assertTrue(tool.posted_within({"posted_on": date(2026, 11, 27)}, 30, today))
        self.assertTrue(tool.posted_within({"posted_on": date(2026, 11, 28)}, 30, today))  # a site's clock is a day ahead
        self.assertTrue(tool.posted_within({"posted_on": None}, 30, today))  # a company page shows no date
        self.assertTrue(tool.posted_within({}, 30, today))

    def test_date_is_30_days_unless_told_and_0_keeps_every_date(self):
        self.assertEqual(options(output_dir=self.root).date, 30)
        self.assertEqual(options("--date=90", output_dir=self.root).date, 90)
        self.assertEqual(options("--date=0", output_dir=self.root).date, 0)
        for bad in ("--date=-1", "--date=abc", "--date=3651", "--date=1.5"):
            with self.subTest(bad):
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                    options(bad, output_dir=self.root)
                self.assertEqual(raised.exception.code, 2)
        today = date.today()
        old = {"title": "Rust Dev", "company": "Acme", "location": "HCM", "work_model": "", "role": "",
               "posted_on": today - timedelta(days=45)}
        fresh = dict(old, posted_on=today - timedelta(days=5))
        undated = dict(old, posted_on=None)
        for args, expected in (
            ((), (False, True, True)),  # the default is 30 days
            (("--date=60",), (True, True, True)),
            (("--date=90",), (True, True, True)),
            (("--date=7",), (False, True, True)),
            (("--date=3",), (False, False, True)),
            (("--date=0",), (True, True, True)),
        ):
            with self.subTest(args):
                opts = options(*args, output_dir=self.root)
                self.assertEqual(tuple(tool.matches(job, opts) for job in (old, fresh, undated)), expected)
        opts = options("--role=Software Engineer", output_dir=self.root)  # the date is one more filter, not a replacement
        self.assertFalse(tool.matches(dict(fresh, title="Sales Manager"), opts))

    def test_old_jobs_are_left_out_of_the_crawl_and_counted_as_filtered(self):
        def written(days_ago):
            return "Posted %d days ago" % days_ago

        page = FakePage({"https://itviec.com/it-jobs": {"cards": [
            card("New Dev", posted=written(2)), card("Month Dev", posted=written(29)),
            card("Old Dev", posted=written(61)), card("No Date Dev", posted="")]}})
        jobs, result = self.crawl(page, ITVIEC)
        self.assertEqual(sorted(job["title"] for job in jobs), ["Month Dev", "New Dev", "No Date Dev"])
        self.assertEqual((result["jobs"], result["filtered_out"]), (3, 1))
        jobs, result = self.crawl(page, ITVIEC, "--date=90")
        self.assertEqual(len(jobs), 4)
        jobs, _ = self.crawl(page, ITVIEC, "--date=0")
        self.assertEqual(len(jobs), 4)

    def test_experience_is_shown_as_years_or_entry_level(self):
        for written, shown in (
            ("4-5 years", "4-5 years"),  # Topicus
            ("4-5 Years", "4-5 years"),
            ("5+ years", "5+ years"),
            ("4 years", "4 years"),
            ("1 year", "1 year"),
            ("2 năm", "2 years"),  # TopCV
            ("1 năm", "1 year"),
            ("3 năm", "3 years"),
            ("1 - 3 năm", "1-3 years"),
            ("3–5 năm", "3-5 years"),
            ("Trên 5 năm", "5+ years"),
            ("Dưới 1 năm", "Under 1 year"),
            ("Dưới 2 năm", "Under 2 years"),
            ("Không yêu cầu", "Entry-level"),
            ("Chưa có kinh nghiệm", "Entry-level"),
            ("Entry level", "Entry-level"),
            ("Entry-level", "Entry-level"),
            ("Fresher", "Entry-level"),
            ("Intern", "Entry-level"),
            ("1,5 năm", "1,5 years"),
            ("", ""),
            ("Senior", "Senior"),  # nothing to read: left as written
            ("Internal tools", "Internal tools"),  # "intern" inside a longer word is not entry-level
        ):
            with self.subTest(written):
                self.assertEqual(tool.format_experience(written), shown)
        self.assertEqual(tool.normalize(card("Rust Dev", experience="Trên 5 năm"), "TopCV", "now")["experience"], "5+ years")

    def test_the_salary_label_is_dropped_and_the_amount_kept(self):
        for written, shown in (
            ("Lương: 3 - 3,0 Triệu VND", "3 - 3,0 Triệu VND"),
            ("Lương: 15 - 25 Triệu VND", "15 - 25 Triệu VND"),
            ("Lương:20 - 30 triệu", "20 - 30 triệu"),
            ("Salary: USD 1,000 - 2,000", "USD 1,000 - 2,000"),
            ("Cạnh tranh", "Cạnh tranh"),
            ("Thoả thuận", "Thoả thuận"),
            ("15 - 25 triệu", "15 - 25 triệu"),
            ("43,000,000 VNĐ - 55,000,000 VNĐ", "43,000,000 VNĐ - 55,000,000 VNĐ"),
            ("Mức lương: tuỳ kinh nghiệm", "Mức lương: tuỳ kinh nghiệm"),  # a different label is not touched
            ("You'll love it", ""),  # ITviec's words for a salary the employer keeps private
            ("You’ll love it", ""),
            ("Negotiable", "Negotiable"),
            ("1,500 - 2,500 USD", "1,500 - 2,500 USD"),
            ("", ""),
        ):
            with self.subTest(written):
                self.assertEqual(tool.clean_salary(written), shown)
        self.assertEqual(tool.normalize(card("Rust Dev", salary="Lương: 8 - 10 Triệu VND"), "CareerViet", "now")["salary"], "8 - 10 Triệu VND")

    def test_every_title_of_one_kind_is_in_one_group(self):
        groups = {
            # Android, iOS, Flutter and React Native titles seen on the real sites are all Mobile
            "Mobile": [
                "Android Security Engineer Intern",
                "Android Developer (Kotlin / Jetpack Compose) - 1 Year Of Experience",
                "Android Developer (Kotlin / Jetpack Compose)",
                "Embedded Android Engineer",
                'Senior "Embedded Android AOSP" Developer',
                "Senior Android Software Engineer (Kotlin, Java)",
                "iOS Engineer (Fluent in English)",
                "Senior iOS Engineer",
                "iOS Developer (Swift, HCMC)",
                "Mobile Developer (Flutter, iOS/Android)",
                "Staff Mobile Engineer (Android/iOS, Fluent in English)",
                "Flutter Developer",
                "React Native Developer",
                "[Remote] Mobile Game Developer (Up to $2,000)",
            ],
            # the Backend titles the user pasted, and more
            "Backend": [
                "Back End Developer (C#)",
                "Backend Developer",
                "Backend .NET Developer - CV Phát triển Ứng dụng nội bộ",
                "Backend Developer (C#, ASP.NET, SQL, Microservices)",
                "Back-end Engineer",
                "Back-end Developer (Java/NodeJS)",
                "Senior Backend Engineer",
                "Backend Software Engineer",  # more specific than Software Engineer
                "Lập Trình Viên Back-End",
                # a server stack next to Developer or Engineer: the title does not say Backend, the job is
                "Senior .NET Developer (English, Lending)",
                ".NET Developer",
                "ASP.NET Developer",
                "C# Developer",
                "Senior Java Engineer",
                "PHP Developer (Laravel)",
                "Python Developer",
                "Golang Developer",
                "Node.js Developer",
                "Ruby on Rails Developer",
                "Lập Trình Viên Java",
                "Senior .NET Developers (C#, SQL, English)",  # plural
                "Lập Trình Viên (.NET)",
                "Mid/Sr Java Developer (English Required) - Up to 3200$",
            ],
            "Software Engineer": [
                "Middle/Senior/Lead Software Engineer, Java",
                "Software Engineer (Java, C#, Scala)",
                "Staff Software Engineer (DevOps, Platform)",
                "Software Developer",
                "Software Engineer Intern",
            ],
            "Fullstack": [
                "Senior Fullstack Software Engineer (Backend, Infra)",
                "Full Stack Engineer",
                "Senior Website Developer - FullStack (PHP, JavaScript)",
                ".NET Developer (Backend/Frontend)",  # names both sides
            ],
            "Frontend": ["Senior Frontend Developer (ReactJS,JavaScript)", "Front-end Developer (JavaScript, ReactJS)"],
            "Product Owner": ["Product Owner - Digital Solution", "ASSOCIATE PRODUCT OWNER (Tiếng Nhật N1)"],
            "Product Manager": ["Senior Product Manager", "Technical Product Manager"],
            "Solution Engineer": ["Senior Solution Engineer / Pre-sales Consultant (English, Banking & Fintech)"],
            "": [
                "Quantitative Developer", "Human Resources Manager", "Accountant", "Digital Marketing (Mobile App)",
                "Data Engineer (Python, Spark)", "QA Engineer (Java, Selenium)", "JavaScript Developer",
                "Java Team Lead", "DevOps Engineer (Python)", "Python Trainer",
                # seen on the real sites with a server stack word in them, and not backend jobs
                "Unity Game Developer (C#)", "Senior Site Reliability Engineer (AWS, Python)",
                "Automation Engineer (Python, Bash shell)", "Low-Code Developer (SQL, Java, RakStudio)",
                "ERP Developer (Odoo, Python, API, PostgreSQL)", "Blockchain Developer (Solidity/Java)",
                "Embedded Firmware Engineer (Linux/C++/Python)",
            ],
        }
        for group, titles in groups.items():
            for title in titles:
                with self.subTest(title):
                    self.assertEqual(tool.role_group(title), group)
        self.assertEqual(set(tool.ROLE_GROUPS), {group for group in groups if group})

    def test_a_row_carries_its_group_and_the_sheet_is_sorted_by_group_then_company(self):
        titles = [
            ("Senior Product Manager", "Zeta"), ("Back End Developer (C#)", "Beta"), ("Software Engineer (Java)", "Acme"),
            ("Backend Developer", "Alpha"), ("Accountant", "Alpha"), ("Android Developer", "Beta"), ("Backend Engineer (Go)", "Alpha"),
        ]
        rows = [tool.normalize(card(title, company=company), "Acme", "now") for title, company in titles]
        self.assertEqual([row["role"] for row in rows][:2], ["Product Manager", "Backend"])
        ordered = tool.sort_jobs(rows)
        self.assertEqual(
            [(row["role"], row["company"], row["title"]) for row in ordered],
            [
                ("Software Engineer", "Acme", "Software Engineer (Java)"),
                ("Backend", "Alpha", "Backend Developer"),
                ("Backend", "Alpha", "Backend Engineer (Go)"),
                ("Backend", "Beta", "Back End Developer (C#)"),
                ("Mobile", "Beta", "Android Developer"),
                ("Product Manager", "Zeta", "Senior Product Manager"),
                ("", "Alpha", "Accountant"),  # no group: last
            ],
        )

    def test_the_group_is_a_column_before_the_title_and_the_titles_stay_as_written(self):
        titles = ["Back End Developer (C#)", "Senior Software Engineer, Java", "Embedded Software Engineer (C++)", ".NET Developer"]
        jobs = tool.sort_jobs([tool.normalize(card(title, company="Acme"), "CareerViet", "now") for title in titles])
        header, csv_header = self.sheet_header_and_csv_header(jobs)
        # the filter list of a column shows what the column holds: the groups are in `role`, the titles untouched
        self.assertEqual(header[:3], ["source", "role", "title"])
        self.assertEqual(csv_header[:3], ["source", "role", "title"])
        with (self.root / "jobs.csv").open(encoding="utf-8-sig") as handle:
            written = [(row["role"], row["title"]) for row in csv.DictReader(handle)]
        self.assertEqual(written, [
            ("Software Engineer", "Embedded Software Engineer (C++)"), ("Software Engineer", "Senior Software Engineer, Java"),
            ("Backend", ".NET Developer"), ("Backend", "Back End Developer (C#)"),  # by company, then by title
        ])

    def test_a_city_is_shown_in_one_spelling_so_the_filter_list_has_one_entry_for_it(self):
        for written, shown in (
            ("Ho Chi Minh", "HCM"),
            ("Hồ Chí Minh (mới)", "HCM"),
            ("VNM Ho Chi Minh", "HCM"),
            ("Ho Chi Minh City, Vietnam", "HCM"),
            ("Ho Chi Minh City Metropolitan Area", "HCM"),
            ("Thành phố Hồ Chí Minh", "HCM"),
            ("TP.HCM", "HCM"),
            ("Saigon", "HCM"),
            ("Ha Noi", "HN"),
            ("Hà Nội", "HN"),
            ("Hanoi Capital Region", "HN"),
            ("Hanoi or Ho Chi Minh City, Vietnam", "HN, HCM"),
            ("Hà Nội; Hồ Chí Minh", "HN, HCM"),
            ("Ha Noi - Ho Chi Minh", "HN, HCM"),  # ITviec
            ("Ho Chi Minh - Ha Noi", "HN, HCM"),  # ITviec, the other way round: the same entry
            ("Hồ Chí Minh (mới) & Hà Nội", "HN, HCM"),  # TopCV
            ("Ha Noi - Ho Chi Minh - Da Nang", "HN, HCM, Da Nang"),
            ("Ho Chi Minh / Remote", "HCM, Remote"),
            ("Ho Chi Minh & Ha Noi", "HN, HCM"),
            # the other provinces without their accents, so that TopCV's and ITviec's spellings are one entry
            ("Đà Nẵng (mới)", "Da Nang"),
            ("Da Nang", "Da Nang"),
            ("Hồ Chí Minh; Đà Nẵng", "HCM, Da Nang"),
            ("HCM; Đà Nẵng", "HCM, Da Nang"),
            ("Hồ Chí Minh (mới); Hồ Chí Minh", "HCM"),
            ("Hồ Chí Minh; Đà Nẵng (mới)", "HCM, Da Nang"),  # TopCV's "(mới)" is dropped everywhere
            ("Đà Nẵng; Cần Thơ", "Da Nang, Can Tho"),
            ("Bà Rịa - Vũng Tàu", "Ba Ria-Vung Tau"),
            ("Bà Rịa - Vũng Tàu; Hồ Chí Minh", "HCM, Ba Ria-Vung Tau"),
            ("Thừa Thiên- Huế", "Hue"),
            ("Đắk Lắk", "Dak Lak"),
            ("Tỉnh Đồng Nai", "Dong Nai"),
            ("Bình Dương; Bình Phước; Hồ Chí Minh", "HCM, Binh Duong, Binh Phuoc"),
            ("Nghệ An, HN, HCM", "HN, HCM, Nghe An"),
            ("Hanoi, Vietnam", "HN"),
            # what only says there are more places, and the parts of a city, are left out
            ("Hà Nội & 2 nơi khác", "HN"),
            ("An Giang (mới) & 2 nơi khác", "An Giang"),
            ("Hà Nội & 9 nơi khác", "HN"),
            ("Ho Chi Minh, Others", "HCM"),
            ("Ho Chi Minh - Quận 1", "HCM"),
            ("Quận 1, Quận 3, Hồ Chí Minh", "HCM"),
            ("HCM Q1, Q2", "HCM"),
            ("Ho Chi Minh - District 7", "HCM"),
            ("Hồ Chí Minh, Thành phố Thủ Đức", "HCM"),
            ("Hồ Chí Minh; Nước Ngoài", "HCM, Overseas"),
            # no Vietnamese place in it: left as the site wrote it
            ("Vietnam", "Vietnam"),
            ("Vietnam-Remote", "Vietnam-Remote"),
            ("USA Remote & Travel", "USA Remote & Travel"),
            ("USA Wilmington, MA – HQ", "USA Wilmington, MA – HQ"),
            ("Singapore", "Singapore"),
            ("Beijing or Shanghai, China", "Beijing or Shanghai, China"),
            ("", ""),
        ):
            with self.subTest(written):
                self.assertEqual(tool.short_location(written), shown)

    def test_every_way_of_writing_the_same_cities_is_one_filter_entry(self):
        same = ["HN, HCM", "Ha Noi - Ho Chi Minh", "Ho Chi Minh - Ha Noi", "Hồ Chí Minh (mới) & Hà Nội", "Hà Nội & Hồ Chí Minh (mới) & 2 nơi khác"]
        self.assertEqual({tool.short_location(text) for text in same}, {"HN, HCM"})
        self.assertEqual({tool.short_location(text) for text in ("Đà Nẵng (mới)", "Da Nang", "Đà Nẵng")}, {"Da Nang"})

    def test_the_filter_reads_what_the_page_said_not_the_short_name(self):
        row = tool.normalize(card("Rust Dev", location="Hanoi or Ho Chi Minh City, Vietnam"), "WorldQuant", "now")
        self.assertEqual((row["location"], row["location_raw"]), ("HN, HCM", "Hanoi or Ho Chi Minh City, Vietnam"))
        for term in ("Ho Chi Minh City", "HCM", "Hanoi", "Ha Noi", "HN", "ha noi, da nang"):
            with self.subTest(term):
                self.assertTrue(tool.matches(row, options("--location=" + term, output_dir=self.root)))
        for term in ("Da Nang", "Singapore", "john"):
            with self.subTest("not " + term):
                self.assertFalse(tool.matches(row, options("--location=" + term, output_dir=self.root)))
        johnstown = tool.normalize(card("QA", location="Johnstown, PA"), "Acme", "now")
        self.assertFalse(tool.matches(johnstown, options("--location=HN", output_dir=self.root)))

    ROLES = (
        "Software Engineer, Fullstack, Front-end, Back-end, Product Owner, Product Manager, Solution Engineer, Mobile"
    )

    def role_matches(self, title, roles=None):
        row = tool.normalize(card(title), "Acme", "now")
        return tool.matches(row, options("--role=" + (roles or self.ROLES), output_dir=self.root))

    def test_the_roles_find_their_jobs_whatever_the_spelling(self):
        # titles seen on the real sites
        for title in (
            "Senior Software Engineer (C#, React)",
            "Staff Software Engineer (DevOps, Platform)",
            "Software Engineer (C/C++)",
            "Software Developer",
            "Full Stack Engineer",
            "Full-stack Developer",
            "(Middle, Senior) FullStack Developer (Java, Go)",
            "Senior Frontend Developer (ReactJS,JavaScript)",
            "Front-end Developer (JavaScript, ReactJS)",
            "Front end Engineer",
            "Back-end Developer (Java/NodeJS)",
            "[Middle, Senior] BackEnd Engineer (Java, Spring Boot)",
            "Senior Backend Engineer",
            "Product Owner (English, AI & Financial Solutions)",
            "Technical Product Manager",
            "Senior Solution Engineer / Pre-sales Consultant (English, Banking & Fintech)",
            "Solutions Engineer",
            "Mobile Developer (Flutter, iOS/Android)",
            "Android Developer",
            "Senior iOS Engineer",
            "Flutter Developer",
            "Mobile App Developer",
            "React Native Developer",
            "Engineer - Mobile",
        ):
            with self.subTest(title):
                self.assertTrue(self.role_matches(title))

    def test_other_jobs_and_look_alike_words_are_left_out(self):
        for title in (
            "Quantitative Developer",
            "Human Resources Manager",
            "Technical Project Manager",
            "Senior Project Manager / Team Lead (Agile, English)",
            "Automation Tester (Intermediate / English)",
            "DevOps Engineer (AWS, Linux)",
            "Software Engineering Manager",  # a manager, not the role
            "Data Engineer (Python, Spark)",  # a stack word next to Engineer is Backend only when the title is not about data,
            "QA Engineer (Java, Selenium)",  # testing
            "JavaScript Developer",  # java is not javascript
            "Business Developer",
            "Product Marketing Specialist",
            "Backendless Platform Lead",
            "Programming Teacher",
        ):
            with self.subTest(title):
                self.assertFalse(self.role_matches(title))
        # "Mobile" is a mobile developer, not every title that mentions mobile (all seen on the real sites)
        for title in (
            "User Acquisition (UA) Marketing (App Mobile)",
            "Digital Marketing Junior (Mobile App), Ho Chi Minh",
            "UI/UX Designer – Mobile app",
            "Business Analyst (Travel Tech – Web & Mobile)",
            "Manager, Mobile Robotics Controls",
        ):
            with self.subTest("mobile only: " + title):
                self.assertFalse(self.role_matches(title, "Mobile"))
        self.assertTrue(self.role_matches("Senior .NET Developer (English, Lending)", ".NET"))
        # ".NET Developer" never says Backend, but it is a Backend job, so --role=Back-end finds it, and so do the others
        for title in ("Senior .NET Developer (English, Lending)", "Java Engineer", "PHP Developer (Laravel)", "Python Developer"):
            with self.subTest("backend by its stack: " + title):
                self.assertTrue(self.role_matches(title, "Back-end"))
                self.assertTrue(self.role_matches(title))  # the default list of roles has Back-end in it
                self.assertFalse(self.role_matches(title, "Front-end"))
        self.assertTrue(tool.matches(tool.normalize(card("Rust Dev"), "Acme", "now"), options(output_dir=self.root)))

    def test_a_role_and_a_location_must_both_match(self):
        opts = options("--role=Software Engineer", "--location=Ho Chi Minh City", output_dir=self.root)
        both = tool.normalize(card("Software Engineer", location="Ho Chi Minh"), "Acme", "now")
        wrong_place = tool.normalize(card("Software Engineer", location="Singapore"), "Acme", "now")
        wrong_role = tool.normalize(card("Accountant", location="Ho Chi Minh"), "Acme", "now")
        self.assertEqual([tool.matches(row, opts) for row in (both, wrong_place, wrong_role)], [True, False, False])

    def test_a_page_that_says_it_has_no_jobs_is_not_a_failure(self):
        axon = tool.SOURCES["axon"]
        page = FakePage({tool.AXON_VIETNAM: {"cards": [], "none": True}})
        jobs, result = self.crawl(page, axon)
        self.assertEqual((jobs, result["status"], result["message"]), ([], "ok", ""))
        self.assertEqual(result["no_jobs_for"], [])

    def test_a_keyword_filters_the_titles_on_a_company_page_that_has_no_search(self):
        topicus = tool.SOURCES["topicus"]
        self.assertEqual(tool.search_terms(topicus, options("--keyword=tester", output_dir=self.root)), [""])
        url = "https://www.topicus.vn/careers"
        page = FakePage(
            {
                url: {
                    "cards": [
                        card("Automation Tester", url=url, company="Topicus Vietnam", tags=["Full time"]),
                        card("Product Owner", url=url, company="Topicus Vietnam", tags=["Full time"]),
                    ]
                }
            }
        )
        jobs, result = self.crawl(page, topicus, "--keyword=TESTER")
        self.assertEqual([job["title"] for job in jobs], ["Automation Tester"])
        self.assertEqual(page.typed, [])
        self.assertEqual(result["filtered_out"], 1)

    def test_every_company_page_is_a_source_on_its_own_host(self):
        for name, label in (
            ("worldquant", "WorldQuant"), ("topicus", "Topicus Vietnam"), ("symbotic", "Symbotic"),
            ("lecle", "Lecle Vietnam"), ("luce", "Luce"), ("axon", "Axon"),
        ):
            with self.subTest(name):
                source = tool.SOURCES[name]
                self.assertEqual(source.label, label)
                self.assertTrue(tool.same_site(source.start_url(""), source.host))
                self.assertFalse(source.searchable)
                self.assertTrue(source.extract.lstrip().startswith("() =>"))
        self.assertTrue(tool.SOURCES["axon"].start_url("").startswith("https://www.axon.com/careers/all?"))

    def test_a_page_the_browser_did_not_leave_is_an_error_that_says_so(self):
        # what the Luce and Axon screenshots showed: the Lecle page, because the browser never moved on
        page = FakePage({"https://www.luce.sg/jobs": {"cards": [card("Rust Dev")]}}, stuck_on="https://www.lecle.vn/careers/")
        jobs, result = self.crawl(page, tool.SOURCES["luce"])
        self.assertEqual((jobs, result["status"]), ([], "error"))
        self.assertIn("stayed on www.lecle.vn instead of opening www.luce.sg", result["message"])
        # a site that only adds or drops "www." is not a stuck browser
        class RedirectsToWww(FakePage):
            def goto(self, url, **kwargs):
                response = super().goto(url, **kwargs)
                self.url = url.replace("https://", "https://www.")
                return response

        page = RedirectsToWww({"https://itviec.com/it-jobs": {"cards": [card("Rust Dev")]}})
        jobs, result = self.crawl(page, ITVIEC)
        self.assertEqual((len(jobs), result["status"]), (1, "ok"))

    def test_main_gives_each_site_a_fresh_tab_and_closes_it(self):
        site = {
            "https://itviec.com/it-jobs": {"cards": [card("Rust Dev")], "next": None},
            "https://www.luce.sg/jobs": {"cards": [card("Go Dev", url="https://www.luce.sg/jobs/go")], "next": None},
        }
        self.run_main(site, "--sources=itviec,luce")
        self.assertEqual(self.context.new_page.call_count, 2)
        self.assertEqual(self.last_page.visited, ["https://itviec.com/it-jobs", "https://www.luce.sg/jobs"])
        self.assertTrue(self.last_page.closed_by_tool)

    class FakeBridge:
        """Answers for ChromeBridge: a name's answer is a string, or a function of the arguments."""

        def __init__(self, **answers):
            self.calls, self.answers = [], answers

        def run(self, name, *args):
            self.calls.append((name, args))
            answer = self.answers.get(name, "")
            return answer(*args) if callable(answer) else answer

    def test_chrome_page_runs_a_reader_and_decodes_what_it_returns(self):
        bridge = self.FakeBridge(javascript=lambda window, code: '[{"title":"Rust Dev"}]' if "JSON.stringify" in code else "")
        page = tool.ChromePage(bridge, 7)
        self.assertEqual(page.evaluate("() => [{ title: 'Rust Dev' }]"), [{"title": "Rust Dev"}])
        self.assertEqual(bridge.calls[0], ("javascript", (7, "JSON.stringify((() => [{ title: 'Rust Dev' }])())")))
        self.assertIsNone(tool.ChromePage(self.FakeBridge(javascript=""), 7).evaluate("() => undefined"))

    def test_chrome_page_counts_matches_with_css_and_with_has_text(self):
        seen = []
        bridge = self.FakeBridge(javascript=lambda window, code: seen.append(code) or "3")
        page = tool.ChromePage(bridge, 7)
        self.assertEqual(page.locator(".job-card, .mini-job-card").count(), 3)
        self.assertEqual(seen[-1], 'document.querySelectorAll(".job-card, .mini-job-card").length')
        self.assertEqual(page.locator('#careers-all p:has-text("We cannot find any career")').count(), 3)
        self.assertIn('document.querySelectorAll("#careers-all p")', seen[-1])
        self.assertIn('includes("We cannot find any career")', seen[-1])

    def test_chrome_page_waits_for_the_new_page_not_the_old_one(self):
        states = iter(["true", "old", "old", "loading", "complete", "https://itviec.com/it-jobs", "200"])
        bridge = self.FakeBridge(javascript=lambda window, code: next(states))
        response = tool.ChromePage(bridge, 7).goto("https://itviec.com/it-jobs")
        self.assertEqual(response.status, 200)
        self.assertEqual([name for name, _ in bridge.calls][:2], ["javascript", "navigate"])
        self.assertEqual(bridge.calls[1], ("navigate", (7, "https://itviec.com/it-jobs")))

    def test_a_hiccup_just_after_a_window_opens_is_retried_but_a_gone_window_is_closed(self):
        gone = "Target page, context or browser has been closed"
        failures = iter([True, True])

        def flaky(window, code):
            if next(failures, False):
                raise tool.ChromeError(gone)
            return "ready"

        bridge = self.FakeBridge(javascript=flaky, exists="true")
        self.assertEqual(tool.ChromePage(bridge, 7).script("1"), "ready")
        self.assertEqual([name for name, _ in bridge.calls].count("javascript"), 3)  # twice failed, then answered

        def always_gone(window, code):
            raise tool.ChromeError(gone)

        bridge = self.FakeBridge(javascript=always_gone, exists="false")
        with self.assertRaises(tool.ChromeError) as raised:
            tool.ChromePage(bridge, 7).script("1")
        self.assertTrue(tool.is_closed(raised.exception))
        self.assertEqual([name for name, _ in bridge.calls].count("javascript"), 1)  # no retry for a closed window

        bridge = self.FakeBridge(javascript=always_gone, exists="true")  # it exists but never answers: give up
        with self.assertRaises(tool.ChromeError):
            tool.ChromePage(bridge, 7).script("1")
        self.assertEqual([name for name, _ in bridge.calls].count("javascript"), 3)

    def test_quiet_windows_keep_their_size_and_hang_off_the_right_edge_of_the_screen(self):
        bridge = tool.ChromeBridge(quiet=True)
        self.assertIsNone(bridge.parked_bounds())  # the screen size is not known yet
        bridge.screen = (1512, 864, 33)
        self.assertEqual(bridge.parked_bounds(), (1480, 73, 2780, 773))  # 1300 by 700, a 32 pixel sliver on screen
        bridge.screen = (1280, 600, 25)
        self.assertEqual(bridge.parked_bounds(), (1248, 65, 2548, 585))  # a short screen shortens the window
        bridge.screen = (1512, 864, 33)
        self.assertEqual(bridge.showing_bounds(), (100, 73, 1300, 793))
        loud = tool.ChromeBridge(quiet=False)
        loud.screen = (1512, 864, 33)
        self.assertIsNone(loud.parked_bounds())  # --show-windows: windows open at their usual size

    def test_a_quiet_window_opens_parked_and_a_challenge_brings_it_forward_and_back(self):
        class QuietBridge(self.FakeBridge):
            def parked_bounds(self):
                return (1480, 73, 2780, 773)

            def showing_bounds(self):
                return (100, 73, 1300, 793)

        bridge = QuietBridge(open_at="7", javascript="complete")
        page = tool.ChromeContext(bridge).new_page()
        self.assertEqual(bridge.calls[0], ("open_at", (1480, 73, 2780, 773)))
        page.show()
        page.hide()
        self.assertEqual(bridge.calls[-3:], [
            ("bounds", (7, 100, 73, 1300, 793)), ("activate", ()), ("bounds", (7, 1480, 73, 2780, 773))])

        class ChallengePage:
            """Shows a Cloudflare check for two looks, then the job cards."""

            def __init__(self):
                self.looks, self.events = 0, []

            def locator(self, selector):
                self.looks += 1
                return FakeLocator(0 if self.looks < 3 else 1)

            def title(self):
                return "Just a moment..."

            def evaluate(self, script):
                return ""

            def show(self):
                self.events.append("show")

            def hide(self):
                self.events.append("hide")

        challenge = ChallengePage()
        with contextlib.redirect_stderr(io.StringIO()):
            state = tool.wait_for_cards(challenge, ITVIEC, options(output_dir=self.root))
        self.assertEqual(state, ("ok", ""))
        self.assertEqual(challenge.events, ["show", "hide"])  # forward for the click, back after
        calm = FakePage({"https://itviec.com/it-jobs": {"cards": [card("Rust Dev")]}})
        calm.goto("https://itviec.com/it-jobs")
        self.assertEqual(tool.wait_for_cards(calm, ITVIEC, options(output_dir=self.root)), ("ok", ""))  # no check: no show

    def quiet_bridge_with_focus(self, front_apps):
        """A quiet ChromeBridge that answers every AppleScript with "complete" and records who gets the focus back."""
        bridge = tool.ChromeBridge(quiet=True)
        bridge.screen = (1512, 864, 33)
        returned = []
        for patch in (
            mock.patch.object(tool, "front_app_path", side_effect=front_apps),
            mock.patch.object(tool, "return_focus", side_effect=returned.append),
            mock.patch.object(tool.ChromeBridge, "_run", return_value="complete"),
        ):
            patch.start()
            self.addCleanup(patch.stop)
        return bridge, returned

    def test_windows_forward_for_a_check_at_the_same_time_give_the_focus_back_once_to_the_app_that_had_it(self):
        # The second window would see Chrome in front, because of the first, and hand the focus to Chrome.
        bridge, returned = self.quiet_bridge_with_focus(["/Applications/Notes.app", "/Applications/Google Chrome.app"])
        first, second = tool.ChromePage(bridge, 7), tool.ChromePage(bridge, 8)
        first.show()
        second.show()
        first.hide()
        self.assertEqual(returned, [])  # the second window is still forward
        second.hide()
        second.hide()  # a window that is not forward has nothing to give back
        self.assertEqual(returned, ["/Applications/Notes.app"])

    def test_each_check_gives_the_focus_back_to_the_app_that_had_it_at_that_time(self):
        bridge, returned = self.quiet_bridge_with_focus(["/Applications/Notes.app", "/Applications/Mail.app"])
        page = tool.ChromePage(bridge, 7)
        for _ in range(2):
            page.show()
            page.hide()
        self.assertEqual(returned, ["/Applications/Notes.app", "/Applications/Mail.app"])

    def test_a_window_that_cannot_come_forward_still_gives_the_focus_back(self):
        bridge, returned = self.quiet_bridge_with_focus(["/Applications/Notes.app"])
        page = tool.ChromePage(bridge, 7)
        with mock.patch.object(tool.ChromeBridge, "_run", side_effect=tool.ChromeError("Chrome would not move it")):
            with self.assertRaises(tool.ChromeError):
                page.show()
        self.assertEqual(returned, ["/Applications/Notes.app"])
        self.assertEqual(bridge._forward, 0)

    def test_the_focus_is_given_back_again_when_chrome_takes_it_a_moment_later(self):
        bridge = tool.ChromeBridge(quiet=True)
        returned = []
        with mock.patch.object(tool, "return_focus", side_effect=returned.append):
            bridge._watched_app, bridge._watch_until, bridge._watching = "/Applications/Notes.app", 1e12, True
            fronts = iter(["/Applications/Notes.app", "/Applications/Google Chrome.app",
                           "/Applications/Google Chrome.app", "/Applications/Google Chrome.app"])
            with mock.patch.object(tool, "front_app_path", side_effect=lambda: next(fronts)):
                self.assertFalse(bridge._watch_step(False))  # Notes is in front: nothing to do
                self.assertEqual(returned, [])
                self.assertFalse(bridge._watch_step(False))  # Chrome has just taken it: give it back, once
                self.assertEqual(returned, ["/Applications/Notes.app"])
                self.assertTrue(bridge._watch_step(True))  # Chrome stays in front: left alone, no fight
                self.assertTrue(bridge._watch_step(True))
                self.assertEqual(returned, ["/Applications/Notes.app"])
            bridge._forward = 1  # a window is forward for a person to click a check: Chrome is meant to be there
            with mock.patch.object(tool, "front_app_path", return_value="/Applications/Google Chrome.app"):
                self.assertTrue(bridge._watch_step(False))
            self.assertEqual(returned, ["/Applications/Notes.app"])
            bridge._forward = 0
            with mock.patch.object(tool, "front_app_path", return_value="/Applications/Mail.app"):
                self.assertFalse(bridge._watch_step(False))  # the person went to Mail: Mail gets it, not Notes
            with mock.patch.object(tool, "front_app_path", return_value="/Applications/Google Chrome.app"):
                bridge._watch_step(False)
            self.assertEqual(returned, ["/Applications/Notes.app", "/Applications/Mail.app"])

    def test_watching_stops_when_time_is_up_or_when_the_person_is_seen_in_chrome(self):
        bridge = tool.ChromeBridge(quiet=True)
        bridge._watched_app, bridge._watch_until, bridge._watching = "/Applications/Notes.app", 0.0, True
        self.assertIsNone(bridge._watch_step(False))  # time is up
        self.assertFalse(bridge._watching)
        with mock.patch.object(tool, "return_focus") as returned, \
                mock.patch.object(tool, "front_app_path", return_value="/Applications/Google Chrome.app"), \
                mock.patch.object(tool.threading, "Thread") as thread:
            real_watch(bridge, "/Applications/Notes.app")  # a command ran with Notes in front: start watching
            self.assertEqual(bridge._watched_app, "/Applications/Notes.app")
            thread.assert_called_once()
            real_watch(bridge, "/Applications/Google Chrome.app")  # a command found the person in Chrome: stop
            self.assertEqual(bridge._watched_app, "")
            self.assertIsNone(bridge._watch_step(False))
            real_watch(bridge, "")  # nobody can be told where they are
            self.assertEqual(bridge._watched_app, "")
        returned.assert_not_called()

    def test_a_command_that_can_take_the_focus_starts_the_watch_with_the_app_in_front(self):
        bridge = tool.ChromeBridge(quiet=True)
        watched = []
        with mock.patch.object(tool.ChromeBridge, "_watch", lambda self, keep: watched.append(keep)), \
                mock.patch.object(tool, "front_app_path", return_value="/Applications/Notes.app"), \
                mock.patch.object(tool, "return_focus") as returned, \
                mock.patch.object(tool.ChromeBridge, "_run", return_value="7"):
            bridge.run("navigate", 7, "https://itviec.com")
            bridge.run("javascript", 7, "1")  # reading a page cannot take the focus
            tool.ChromeBridge(quiet=False).run("navigate", 7, "https://itviec.com")  # --show-windows: left alone
        self.assertEqual(watched, ["/Applications/Notes.app"])
        returned.assert_called_once_with("/Applications/Notes.app")

    def test_the_app_you_were_using_gets_the_focus_back_after_a_window_opens(self):
        returned = []
        fake = tool.ChromeBridge(quiet=True)
        with mock.patch.object(tool, "front_app_path", return_value="/Applications/Microsoft Excel.app"), \
                mock.patch.object(tool, "return_focus", side_effect=returned.append), \
                mock.patch.object(tool.ChromeBridge, "_run", return_value="7"):
            fake.run("open")
            fake.run("navigate", 7, "https://itviec.com")
            fake.run("javascript", 7, "1")  # reading a page cannot take the focus: nothing to give back
            tool.ChromeBridge(quiet=False).run("open")  # --show-windows: left alone
        self.assertEqual(returned, ["/Applications/Microsoft Excel.app"] * 2)
        with mock.patch.object(tool.subprocess, "run") as run:
            tool.return_focus("/Applications/Google Chrome.app")  # already Chrome: nothing to do
            tool.return_focus("")
        run.assert_not_called()
        done = mock.Mock(stdout='"LSBundlePath"="/Applications/Microsoft Excel.app"\n')
        with mock.patch.object(tool.subprocess, "run", return_value=done):
            self.assertEqual(tool.front_app_path(), "/Applications/Microsoft Excel.app")
        with mock.patch.object(tool.subprocess, "run", side_effect=OSError):
            self.assertEqual(tool.front_app_path(), "")  # no lsappinfo: quiet mode just does not move the focus

    def test_my_chrome_reads_the_screen_size_and_show_windows_turns_quiet_mode_off(self):
        self.addCleanup(setattr, tool, "PlaywrightError", tool.PlaywrightError)
        bridge = self.FakeBridge(open="7", javascript=lambda window, code: "1512,864,33" if "screen" in code else "2")
        with mock.patch.object(tool.sys, "platform", "darwin"), mock.patch.object(tool, "ChromeBridge", return_value=bridge) as made:
            real_connect_real_chrome(quiet=True)
            self.assertEqual(made.call_args.args, (True, "Default"))
            real_connect_real_chrome(quiet=False, profile="Profile 3")
            self.assertEqual(made.call_args.args, (False, "Profile 3"))
        self.assertEqual(bridge.screen, (1512, 864, 33))
        self.assertFalse(options(output_dir=self.root).show_windows)
        self.assertTrue(options("--show-windows", output_dir=self.root).show_windows)

    def test_a_window_is_opened_in_the_chosen_chrome_profile_whichever_was_used_last(self):
        ids = iter(["10, 11", "10, 11, 12"])  # the window ids before and after the new window
        bridge = tool.ChromeBridge(quiet=False, profile="Profile 3")
        commands = []

        def started(command, **kwargs):
            commands.append(command)
            return mock.Mock(returncode=0)

        with mock.patch.object(tool.ChromeBridge, "_run", side_effect=lambda name, *args: next(ids)), \
                mock.patch.object(tool.subprocess, "run", side_effect=started):
            self.assertEqual(bridge.open_window(), "12")  # the id that was not there before
        # Chrome's own program, which hands the request to the running Chrome: not `open -na`, which registers
        # a second Chrome that AppleScript sometimes talked to while it was quitting
        self.assertEqual(commands[0], [tool.CHROME_PROGRAM, "--profile-directory=Profile 3", "--new-window", "about:blank"])
        self.assertNotIn("open", commands[0][0])

    def test_a_dropped_connection_to_chrome_is_asked_again_before_giving_up(self):
        busy = mock.Mock(returncode=1, stderr="execution error: Connection is invalid. (-609)", stdout="")
        fine = mock.Mock(returncode=0, stderr="", stdout="42\n")
        bridge = tool.ChromeBridge()
        with mock.patch.object(tool.subprocess, "run", side_effect=[busy, busy, fine]) as run:
            self.assertEqual(bridge.run("javascript", 7, "1"), "42")  # two dropped connections, then an answer
        self.assertEqual(run.call_count, 3)
        with mock.patch.object(tool.subprocess, "run", side_effect=[busy, busy, busy]) as run:
            with self.assertRaises(tool.ChromeError) as raised:
                bridge.run("javascript", 7, "1")
        self.assertIn("-609", str(raised.exception))
        self.assertEqual(run.call_count, 3)  # three tries, then the error is shown
        isnt_running = mock.Mock(returncode=1, stderr="Application isn’t running. (-600)", stdout="")
        with mock.patch.object(tool.subprocess, "run", side_effect=[isnt_running, fine]):
            self.assertEqual(bridge.run("javascript", 7, "1"), "42")

    def test_chrome_must_be_installed_and_open(self):
        with mock.patch.object(tool, "CHROME_PROGRAM", "/nowhere/Chrome"):
            self.assertIn("could not find Google Chrome", real_chrome_problem())
        with mock.patch.object(tool, "CHROME_PROGRAM", "/bin/sh"):  # something that exists
            with mock.patch.object(tool.subprocess, "run", return_value=mock.Mock(returncode=1)):
                self.assertIn("not open", real_chrome_problem())
            with mock.patch.object(tool.subprocess, "run", return_value=mock.Mock(returncode=0)):
                self.assertEqual(real_chrome_problem(), "")

    def test_no_new_window_in_the_profile_is_an_error_that_names_it(self):
        bridge = tool.ChromeBridge(quiet=False, profile="Profile 9")
        with mock.patch.object(tool.ChromeBridge, "_run", return_value="10, 11"), \
                mock.patch.object(tool.subprocess, "run", return_value=mock.Mock(returncode=0)):
            with self.assertRaises(tool.ChromeError) as raised:
                bridge.open_window()
        self.assertIn("Profile 9", str(raised.exception))

    def test_a_missing_setting_names_the_profile_and_how_to_pick_another(self):
        self.addCleanup(setattr, tool, "PlaywrightError", tool.PlaywrightError)

        def turned_off(window, code):
            raise tool.ChromeError("Executing JavaScript through AppleScript is turned off.")

        bridge = self.FakeBridge(open="7", javascript=turned_off)
        with mock.patch.object(tool.sys, "platform", "darwin"), mock.patch.object(tool, "ChromeBridge", return_value=bridge):
            with self.assertRaises(SystemExit) as raised:
                real_connect_real_chrome(profile="Profile 3")
        message = str(raised.exception)
        self.assertIn("'Profile 3'", message)
        self.assertIn("--chrome-profile", message)
        self.assertEqual(options(output_dir=self.root).chrome_profile, "")  # not named: it is found
        self.assertEqual(options("--chrome-profile=Profile 3", output_dir=self.root).chrome_profile, "Profile 3")

    def chrome_folder(self, enabled=(), disabled=(), state=None, broken=(), folder="chrome"):
        """A fake Chrome folder with a Preferences file per profile and a Local State."""
        root = self.root / folder
        for names, browser in ((enabled, {"allow_javascript_apple_events": True}),
                               (disabled, {"allow_javascript_apple_events": False})):
            for name in names:
                (root / name).mkdir(parents=True)
                (root / name / "Preferences").write_text(json.dumps({"browser": browser, "other": {"x": 1}}), encoding="utf-8")
        for name in broken:
            (root / name).mkdir(parents=True)
            (root / name / "Preferences").write_text("{not json", encoding="utf-8")
        if state is not None:
            root.mkdir(parents=True, exist_ok=True)
            (root / "Local State").write_text(json.dumps({"profile": state}), encoding="utf-8")
        return root

    def test_the_chrome_profiles_with_the_setting_on_are_found_the_last_used_first(self):
        root = self.chrome_folder(
            enabled=("Default", "Profile 3", "Profile 10"), disabled=("Profile 1",), broken=("Profile 2",),
            state={"last_used": "Profile 3", "profiles_order": ["Default", "Profile 1", "Profile 3", "Profile 10"]})
        for system in ("System Profile", "Guest Profile"):  # not a person's profile, even with the setting on
            (root / system).mkdir()
            (root / system / "Preferences").write_text('{"browser": {"allow_javascript_apple_events": true}}', encoding="utf-8")
        self.assertEqual(tool.chrome_profiles_with_apple_events(root), ["Profile 3", "Default", "Profile 10"])
        self.assertEqual(tool.chrome_profiles_with_apple_events(self.root / "nowhere"), [])
        # no Local State: by name, and a profile it does not list comes after the ones it lists
        root = self.chrome_folder(enabled=("Profile 9", "Default"), folder="no-state")
        self.assertEqual(tool.chrome_profiles_with_apple_events(root), ["Default", "Profile 9"])
        (root / "Local State").write_text("[1, 2]", encoding="utf-8")  # not what Chrome writes: ignored
        self.assertEqual(tool.chrome_profiles_with_apple_events(root), ["Default", "Profile 9"])

    def test_on_a_mac_with_chrome_your_chrome_and_its_profile_are_chosen_without_flags(self):
        def chosen(*args, found=("Profile 3",), mac=True, installed=True):
            opts = options(*args, output_dir=self.root)
            with mock.patch.object(tool.sys, "platform", "darwin" if mac else "linux"), \
                    mock.patch.object(tool, "chrome_installed", return_value=installed), \
                    mock.patch.object(tool, "chrome_profiles_with_apple_events", return_value=list(found)) as looked:
                with contextlib.redirect_stderr(io.StringIO()) as log:
                    tool.choose_browser(opts)
            return opts, looked.call_count, log.getvalue()

        opts, looked, log = chosen()
        self.assertEqual((opts.my_chrome, opts.chrome_profile, looked), (True, "Profile 3", 1))
        self.assertIn("'Profile 3'", log)
        opts, _, log = chosen(found=("Default", "Profile 3"))
        self.assertEqual(opts.chrome_profile, "Default")  # several have it on: the first, and the log says so
        self.assertIn("so do Profile 3", log)
        opts, looked, _ = chosen("--chrome-profile=Profile 7")
        self.assertEqual((opts.my_chrome, opts.chrome_profile, looked), (True, "Profile 7", 0))  # as named
        opts, looked, _ = chosen("--my-chrome")
        self.assertEqual((opts.my_chrome, opts.chrome_profile, looked), (True, "Profile 3", 1))
        for args, kwargs in (
            (("--own-browser",), {}), (("--headless",), {}), ((), {"mac": False}), ((), {"installed": False}),
        ):
            with self.subTest(args, **kwargs):
                opts, looked, _ = chosen(*args, **kwargs)
                self.assertEqual((opts.my_chrome, opts.chrome_profile, looked), (False, "", 0))  # the tool's own browser
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            options("--my-chrome", "--own-browser", output_dir=self.root)

    def test_a_missing_setting_in_every_profile_says_where_to_turn_it_on(self):
        for args in ((), ("--my-chrome",)):
            with self.subTest(args):
                opts = options(*args, output_dir=self.root)
                with mock.patch.object(tool.sys, "platform", "darwin"), \
                        mock.patch.object(tool, "chrome_installed", return_value=True), \
                        mock.patch.object(tool, "chrome_profiles_with_apple_events", return_value=[]):
                    with self.assertRaises(SystemExit) as raised:
                        tool.choose_browser(opts)
                message = str(raised.exception)
                self.assertIn("View -> Developer -> Allow JavaScript from Apple Events", message)
                self.assertIn("run this again", message)
                self.assertIn("--own-browser", message)

    def test_a_worker_reuses_its_window_for_every_page_it_reads(self):
        site = self.paged_site(pages=9)
        context = FakeContext(site)
        jobs, result = self.crawl(FakePage(site), ITVIEC, "--my-chrome", "--pages-at-once=2", context=context)
        self.assertEqual((result["pages"], len(jobs)), (9, 18))
        self.assertTrue(1 <= len(context.windows) <= 2)  # 8 pages, at most 2 windows
        self.assertTrue(all(window.closed_by_tool for window in context.windows))
        self.assertTrue(sum(len(window.visited) for window in context.windows) == 8)

    def test_a_new_window_is_used_only_after_it_has_stopped_loading_its_new_tab_page(self):
        states = iter(["loading", "loading", "complete"])
        bridge = self.FakeBridge(open="7", javascript=lambda window, code: next(states))
        page = tool.ChromeContext(bridge).new_page()
        self.assertEqual(page.window_id, 7)
        self.assertEqual([name for name, _ in bridge.calls], ["open", "javascript", "javascript", "javascript"])

        def broken(window, code):
            raise tool.ChromeError("Executing JavaScript through AppleScript is turned off.")

        bridge = self.FakeBridge(open="9", javascript=broken)
        with self.assertRaises(tool.ChromeError):
            tool.ChromeContext(bridge).new_page()
        self.assertIn(("close", (9,)), bridge.calls)  # an unusable window is not left open

    def test_an_address_the_window_overwrote_with_its_new_tab_page_is_sent_again(self):
        hrefs = iter(["chrome://new-tab-page/", "https://www.topcv.vn/x"])  # the first try is lost, the second lands

        def answers(window, code):
            if code == "location.href":
                return next(hrefs)
            if "readyState" in code:
                return "complete"
            if "responseStatus" in code:
                return "200"
            return "true"

        bridge = self.FakeBridge(javascript=answers)
        response = tool.ChromePage(bridge, 7).goto("https://www.topcv.vn/x")
        self.assertEqual(response.status, 200)
        self.assertEqual([name for name, _ in bridge.calls].count("navigate"), 2)

        def always_new_tab(window, code):
            return "chrome://new-tab-page/" if code == "location.href" else answers(window, code)

        bridge = self.FakeBridge(javascript=always_new_tab)
        tool.ChromePage(bridge, 7).goto("https://www.topcv.vn/x")
        self.assertEqual([name for name, _ in bridge.calls].count("navigate"), 3)  # three tries, then open_page says so

    def test_chrome_page_gives_up_when_a_page_never_loads(self):
        bridge = self.FakeBridge(javascript="old")
        with self.assertRaises(tool.ChromeError) as raised:
            tool.ChromePage(bridge, 7).goto("https://itviec.com/it-jobs", timeout=1)
        self.assertIn("did not load", str(raised.exception))
        self.assertEqual([name for name, _ in bridge.calls].count("navigate"), 2)  # the address was sent twice

        loads = iter(["complete"])  # the page that loads after the address is sent the second time

        def late(window, code):
            if "__crawlerLeft ?" in code:
                return next(loads)
            return "200" if "responseStatus" in code else "https://itviec.com/it-jobs"

        bridge = self.FakeBridge(javascript=late)
        # the clock reads: the first try's deadline, then past it; the second try's deadline, then inside it
        with mock.patch.object(tool.time, "monotonic", side_effect=iter([0, 100, 100, 100])):
            response = tool.ChromePage(bridge, 7).goto("https://itviec.com/it-jobs")
        self.assertEqual(response.status, 200)
        self.assertEqual([name for name, _ in bridge.calls].count("navigate"), 2)

    def test_chrome_page_types_into_a_search_box_with_the_text_quoted(self):
        seen = []
        bridge = self.FakeBridge(javascript=lambda window, code: seen.append(code) or "")
        page = tool.ChromePage(bridge, 7)
        page.fill("#keyword", 'say "hi"')
        page.press("#keyword", "Enter")
        self.assertIn('document.querySelector("#keyword")', seen[0])
        self.assertIn('box.value = "say \\"hi\\""', seen[0])
        self.assertIn("keydown", seen[1])
        self.assertIn('key: "Enter"', seen[1])

    def test_chrome_bridge_turns_osascript_failures_into_clear_errors(self):
        def failing(stderr, stdout=""):
            return mock.Mock(returncode=1, stderr=stderr, stdout=stdout)

        bridge = tool.ChromeBridge()
        with mock.patch.object(tool.subprocess, "run", return_value=failing("execution error: Can’t get window id 5. (-1728)")):
            with self.assertRaises(tool.ChromeError) as raised:
                bridge.run("close", 5)
        self.assertIn("-1728", raised.exception.raw)  # what Chrome really said travels with the error
        self.assertTrue(tool.is_closed(raised.exception))
        # it is logged only when the window really is gone, not for a hiccup that a retry gets past
        gone = tool.ChromeBridge()

        def window_is_gone(name, *args):
            if name == "exists":
                return "false"
            raise raised.exception

        with mock.patch.object(tool.ChromeBridge, "_run", side_effect=window_is_gone), \
                contextlib.redirect_stderr(io.StringIO()) as logged:
            with self.assertRaises(tool.ChromeError):
                tool.ChromePage(gone, 5).ask("javascript", "1")  # the window is gone: says why, no retry
        self.assertIn("AppleScript said", logged.getvalue())
        with mock.patch.object(tool.subprocess, "run", return_value=failing("JavaScript through AppleScript is turned off")):
            with self.assertRaises(tool.ChromeError) as raised:
                bridge.run("javascript", 5, "1")
        self.assertIn("turned off", str(raised.exception))
        with mock.patch.object(tool.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="missing value\n", stderr="")):
            self.assertEqual(bridge.run("javascript", 5, "1"), "")
        with mock.patch.object(tool.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="line one\nline two\n", stderr="")):
            self.assertEqual(bridge.run("javascript", 5, "1"), "line one\nline two")

    def test_my_chrome_says_how_to_fix_what_is_wrong_and_never_quits_chrome(self):
        self.addCleanup(setattr, tool, "PlaywrightError", tool.PlaywrightError)
        with mock.patch.object(tool.sys, "platform", "linux"):
            with self.assertRaises(SystemExit) as raised:
                real_connect_real_chrome()
        self.assertIn("only macOS has", str(raised.exception))

        def turned_off(window, code):
            raise tool.ChromeError("Executing JavaScript through AppleScript is turned off.")

        bridge = self.FakeBridge(open="7", javascript=turned_off)
        with mock.patch.object(tool.sys, "platform", "darwin"), mock.patch.object(tool, "ChromeBridge", return_value=bridge):
            with self.assertRaises(SystemExit) as raised:
                real_connect_real_chrome()
        self.assertIn("Allow JavaScript from Apple Events", str(raised.exception))
        self.assertIn(("close", (7,)), bridge.calls)  # the test window is closed even on failure

        working = self.FakeBridge(open="7", javascript="2")
        with mock.patch.object(tool.sys, "platform", "darwin"), mock.patch.object(tool, "ChromeBridge", return_value=working):
            context = real_connect_real_chrome()
        context.close()
        self.assertNotIn("quit", [name for name, _ in working.calls])
        self.assertEqual(
            [name for name, _ in working.calls], ["open", "javascript", "javascript", "javascript", "close"])  # settle, sum, screen size

    BASE = "https://itviec.com/it-jobs"

    def paged_site(self, pages=5, per_page=2, blocked=None, repeat=None):
        """A site whose page N is BASE?page=N...: page 1 says how many pages there are."""
        site = {self.BASE: {"cards": [card("Job 1a"), card("Job 1b")], "total_pages": pages,
                            "next": self.BASE + "?page=2&query=&source=search_job"}}
        for number in range(2, pages + 1):
            cards = [card("Job %d%s" % (number, letter)) for letter in "abcdef"[:per_page]]
            if repeat and number == repeat[0]:
                cards.append(card(repeat[1]))
            following = self.BASE + "?page=%d&query=&source=search_job" % (number + 1) if number < pages else None
            site[self.BASE + "?page=%d&query=&source=search_job" % number] = (
                {"status": 403, "title": "Attention Required! | Cloudflare", "cards": []}
                if number == blocked else {"cards": cards, "next": following})
        return site

    def test_page_addresses_are_made_from_the_address_of_page_two(self):
        template = tool.page_template("https://itviec.com/it-jobs?page=2&query=&source=search_job")
        self.assertEqual(template(7), "https://itviec.com/it-jobs?page=7&query=&source=search_job")
        template = tool.page_template("https://www.topcv.vn/tim-viec-lam-cong-nghe-thong-tin-cr257?page=2")
        self.assertEqual(template(46), "https://www.topcv.vn/tim-viec-lam-cong-nghe-thong-tin-cr257?page=46")
        template = tool.page_template("https://careerviet.vn/viec-lam/cntt-phan-mem-c1-trang-2-vi.html")
        self.assertEqual(template(9), "https://careerviet.vn/viec-lam/cntt-phan-mem-c1-trang-9-vi.html")
        self.assertIsNone(tool.page_template("https://www.axon.com/careers/all"))
        self.assertIsNone(tool.page_template("https://itviec.com/it-jobs?page=20"))  # not page 2

    def test_the_other_pages_are_read_side_by_side_in_windows_of_their_own(self):
        site = self.paged_site(pages=5)
        context = FakeContext(site)
        jobs, result = self.crawl(FakePage(site), ITVIEC, "--my-chrome", "--pages-at-once=3", context=context)
        self.assertEqual(
            sorted(job["title"] for job in jobs),
            sorted(["Job 1a", "Job 1b"] + ["Job %d%s" % (n, letter) for n in range(2, 6) for letter in "ab"]))
        self.assertEqual((result["status"], result["pages"], result["jobs"], result["more_pages"]), ("ok", 5, 10, False))
        # pages 2 to 5 are read by at most 3 workers, and each worker reuses its one window for every page it reads
        self.assertTrue(1 <= len(context.windows) <= 3)
        self.assertTrue(all(window.closed_by_tool for window in context.windows))
        self.assertEqual(
            {address for window in context.windows for address in window.visited},
            {self.BASE + "?page=%d&query=&source=search_job" % number for number in range(2, 6)})

    def test_a_page_that_comes_back_blank_is_looked_at_once_more_before_it_counts_as_empty(self):
        class BlankFirst(dict):
            """The address answers with a blank list that many times before it answers with its jobs."""

            def __init__(self, site, address, blanks):
                super().__init__(site)
                self.address, self.blanks = address, blanks

            def __getitem__(self, address):
                if address == self.address and self.blanks:
                    self.blanks -= 1
                    return {"status": 200, "title": "IT Jobs", "text": "nothing yet", "cards": []}
                return super().__getitem__(address)

        page_three = self.BASE + "?page=3&query=&source=search_job"
        site = BlankFirst(self.paged_site(pages=4), page_three, blanks=1)
        jobs, result = self.crawl(FakePage(site), ITVIEC, "--my-chrome", "--pages-at-once=2", context=FakeContext(site))
        self.assertEqual((result["status"], result["pages"], len(jobs)), ("ok", 4, 8))  # nothing lost
        site = BlankFirst(self.paged_site(pages=4), page_three, blanks=2)  # blank twice: that is what the page says
        jobs, result = self.crawl(FakePage(site), ITVIEC, "--my-chrome", "--pages-at-once=1", context=FakeContext(site))
        self.assertEqual((result["status"], result["message"]), ("empty", tool.STATE_MESSAGES["empty"]))
        self.assertEqual(len(jobs), 4)  # pages 1 and 2; page 4 never started

    def test_a_job_that_turns_up_on_two_pages_is_kept_once(self):
        site = self.paged_site(pages=4, repeat=(3, "Job 2a"))  # page 3 repeats a job from page 2
        jobs, result = self.crawl(FakePage(site), ITVIEC, "--my-chrome", "--pages-at-once=4", context=FakeContext(site))
        self.assertEqual(len(jobs), len({job["url"] for job in jobs}))
        self.assertEqual(result["duplicates"], 1)
        self.assertEqual(len(jobs), 2 + 2 * 3 - 0)  # 8 jobs, the repeat counted once

    def test_a_cut_off_by_max_pages_says_there_are_more(self):
        site = self.paged_site(pages=5)
        context = FakeContext(site)
        jobs, result = self.crawl(FakePage(site), ITVIEC, "--my-chrome", "--pages-at-once=2", "--max-pages=3", context=context)
        self.assertEqual((result["pages"], len(jobs), result["more_pages"]), (3, 6, True))
        self.assertTrue(1 <= len(context.windows) <= 2)  # two pages read by at most two workers

    def test_the_first_failure_is_reported_and_stops_pages_that_have_not_started(self):
        site = self.paged_site(pages=8, blocked=3)
        context = FakeContext(site)
        jobs, result = self.crawl(FakePage(site), ITVIEC, "--my-chrome", "--pages-at-once=1", context=context)
        # one window at a time makes the order certain: pages 2 is read, page 3 is blocked, the rest never start
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(sorted(job["title"] for job in jobs), ["Job 1a", "Job 1b", "Job 2a", "Job 2b"])
        context = FakeContext(site)
        jobs, result = self.crawl(FakePage(site), ITVIEC, "--my-chrome", "--pages-at-once=3", context=context)
        self.assertEqual(result["status"], "blocked")
        self.assertNotIn("Job 3a", [job["title"] for job in jobs])
        self.assertTrue(all(window.closed_by_tool for window in context.windows))

    class BlockedFirst(dict):
        """A site that blocks the first `blocks` loads of one address and then lets it through."""

        def __init__(self, site, address, blocks):
            super().__init__(site)
            self.address, self.blocks = address, blocks

        def __getitem__(self, address):
            if address == self.address and self.blocks:
                self.blocks -= 1
                return {"status": 403, "title": "Attention Required! | Cloudflare", "cards": []}
            return super().__getitem__(address)

    def test_a_site_that_blocks_the_windows_is_left_alone_for_a_while_and_the_pages_left_are_read_again(self):
        page_three = self.BASE + "?page=3&query=&source=search_job"
        site = self.BlockedFirst(self.paged_site(pages=6), page_three, blocks=1)
        context = FakeContext(site)
        with mock.patch.object(tool.time, "sleep") as slept:
            jobs, result = self.crawl(FakePage(site), ITVIEC, "--my-chrome", "--pages-at-once=4", context=context)
        self.assertIn(mock.call(tool.BLOCK_COOLDOWN), slept.call_args_list)  # it waited
        self.assertEqual((result["status"], result["message"]), ("ok", ""))  # and the block is not held against the site
        self.assertEqual((result["pages"], len(jobs)), (6, 12))  # every page, once
        self.assertTrue(all(window.closed_by_tool for window in context.windows))
        self.assertLessEqual(len(context.windows), 4 + tool.RETRY_WINDOWS)  # the retry opened no more than its two

    def test_a_second_block_ends_the_site_and_keeps_what_was_read(self):
        page_four = self.BASE + "?page=4&query=&source=search_job"
        site = self.BlockedFirst(self.paged_site(pages=6), page_four, blocks=99)  # never lets page 4 through
        with mock.patch.object(tool.time, "sleep") as slept:
            jobs, result = self.crawl(FakePage(site), ITVIEC, "--my-chrome", "--pages-at-once=3", context=FakeContext(site))
        self.assertEqual(slept.call_args_list.count(mock.call(tool.BLOCK_COOLDOWN)), 1)  # it waited once, not again and again
        self.assertEqual(result["status"], "blocked")
        titles = {job["title"] for job in jobs}
        self.assertTrue({"Job 1a", "Job 2a", "Job 3a"} <= titles)  # what was read before the block stays
        self.assertNotIn("Job 4a", titles)

    def test_one_window_that_is_blocked_is_not_given_a_second_try_with_more_windows(self):
        page_three = self.BASE + "?page=3&query=&source=search_job"
        site = self.BlockedFirst(self.paged_site(pages=5), page_three, blocks=1)
        with mock.patch.object(tool.time, "sleep") as slept:
            jobs, result = self.crawl(FakePage(site), ITVIEC, "--my-chrome", "--pages-at-once=1", context=FakeContext(site))
        # --pages-at-once=1 reads one by one with the next-page links: no windows side by side, so no cooldown retry
        self.assertNotIn(mock.call(tool.BLOCK_COOLDOWN), slept.call_args_list)
        self.assertEqual(result["status"], "blocked")

    def test_without_a_page_count_or_with_one_window_pages_are_read_one_by_one(self):
        site = self.paged_site(pages=3)
        site[self.BASE]["total_pages"] = None  # the site's count could not be read
        context = FakeContext(site)
        self.crawl(FakePage(site), ITVIEC, "--my-chrome", "--pages-at-once=3", context=context)
        self.assertEqual(context.windows, [])
        site = self.paged_site(pages=3)
        context = FakeContext(site)
        jobs, _ = self.crawl(FakePage(site), ITVIEC, "--my-chrome", "--pages-at-once=1", context=context)
        self.assertEqual(context.windows, [])
        self.assertEqual(len(jobs), 2 + 2 * 2)  # nothing lost either way
        context = FakeContext(site)  # and not at all without --my-chrome
        self.crawl(FakePage(site), ITVIEC, context=context)
        self.assertEqual(context.windows, [])

    def test_several_sites_are_read_at_once_each_in_its_own_window(self):
        site = {
            "https://itviec.com/it-jobs": {"cards": [card("Rust Dev")], "next": None},
            "https://www.luce.sg/jobs": {"cards": [card("Go Dev", url="https://www.luce.sg/jobs/go")], "next": None},
            "https://www.lecle.vn/careers/": {"cards": [card("Dart Dev", url="https://www.lecle.vn/careers")], "next": None},
        }
        context = FakeContext(site)
        opts = options("--my-chrome", "--sites-at-once=3", "--sources=itviec,luce,lecle", output_dir=self.root)
        jobs, seen, results = [], set(), {}
        with contextlib.redirect_stderr(io.StringIO()):
            tool.collect(context, opts, jobs, seen, results, self.root / "run")
        self.assertEqual({name: results[name]["status"] for name in results}, {"itviec": "ok", "luce": "ok", "lecle": "ok"})
        self.assertEqual(sorted(job["title"] for job in jobs), ["Dart Dev", "Go Dev", "Rust Dev"])
        self.assertEqual(len(context.windows), 3)
        self.assertTrue(all(window.closed_by_tool for window in context.windows))
        self.assertEqual(list(results), ["itviec", "luce", "lecle"])  # the report keeps the order asked for

    def test_one_site_failing_does_not_stop_the_others_when_they_run_at_once(self):
        site = {"https://www.luce.sg/jobs": {"cards": [card("Go Dev", url="https://www.luce.sg/jobs/go")], "next": None}}

        class WindowsThatDie(FakeContext):
            def new_page(self):
                window = super().new_page()
                window.closed = "goto"  # this window is gone as soon as it is used
                return window

        class FirstWindowDies(FakeContext):
            def new_page(self):
                window = super().new_page()
                if len(self.windows) == 1:
                    window.closed = "goto"
                return window

        opts = options("--my-chrome", "--sites-at-once=2", "--sources=itviec,luce", output_dir=self.root)
        jobs, seen, results = [], set(), {}
        with contextlib.redirect_stderr(io.StringIO()):
            tool.collect(FirstWindowDies(site), opts, jobs, seen, results, self.root / "run")
        self.assertEqual(results["itviec"]["status"], "error")
        self.assertEqual(results["itviec"]["message"], tool.CLOSED_MESSAGE)
        self.assertEqual(results["luce"]["status"], "ok")
        self.assertEqual([job["title"] for job in jobs], ["Go Dev"])

    INDEED = tool.SOURCES["indeed"]

    def test_indeed_is_searched_for_each_role_in_each_place(self):
        def searches(*args):
            found = tool.search_terms(self.INDEED, options(*args, output_dir=self.root))
            return [(str(search), search.place) for search in found]

        self.assertEqual(searches(), [("software engineer", "Vietnam"), ("developer", "Vietnam")])  # it lists nothing without one
        self.assertEqual(searches("--keyword=python"), [("python", "Vietnam")])
        self.assertEqual(
            searches("--role=Backend, Software Engineer, Product Owner"),
            [("backend developer", "Vietnam"), ("software engineer", "Vietnam"), ("Product Owner", "Vietnam")])
        self.assertEqual(
            searches("--role=Front-end", "--location=Ho Chi Minh City, HCM, Remote, Hanoi, Da Nang"),
            [("frontend developer", "Ho Chi Minh"), ("frontend developer", "Remote"), ("frontend developer", "Ha Noi"),
             ("frontend developer", "Da Nang")])  # HCM and Ho Chi Minh City are one place
        self.assertEqual(repr(tool.Search("a b", "Ha Noi")), "'a b' in 'Ha Noi'")
        self.assertEqual(repr(tool.Search("a b")), "'a b'")
        # the other sites are not searched this way
        self.assertEqual(tool.search_terms(ITVIEC, options("--role=Backend", output_dir=self.root)), [""])

    def test_an_indeed_search_is_a_result_page_of_its_own(self):
        self.assertEqual(
            self.INDEED.start_url(tool.Search("software engineer", "Ho Chi Minh")),
            "https://vn.indeed.com/jobs?q=software+engineer&l=Ho+Chi+Minh")
        self.assertEqual(self.INDEED.start_url("python"), "https://vn.indeed.com/jobs?q=python&l=Vietnam")

    def test_indeed_pages_are_written_the_way_robots_txt_allows(self):
        # `&start=` is disallowed unless it is 0 to 90 and another parameter follows; ten pages at most
        template = tool.page_template("https://vn.indeed.com/jobs?q=a+b&l=Ho+Chi+Minh&start=10&radius=25")
        urls = [template(number) for number in range(2, 11)]

        self.assertEqual(urls[0], "https://vn.indeed.com/jobs?q=a+b&l=Ho+Chi+Minh&start=10&radius=25")
        self.assertEqual(urls[-1], "https://vn.indeed.com/jobs?q=a+b&l=Ho+Chi+Minh&start=90&radius=25")
        for url in urls:
            self.assertRegex(url, r"&start=(?:[1-9]0)&")
        self.assertIn("start <= 90", self.INDEED.next_page)  # no link beyond start=90 is followed
        self.assertIn("&radius=25", self.INDEED.next_page)  # and start is never the last parameter
        self.assertIn("Math.min(10", self.INDEED.total_pages)
        self.assertIsNone(tool.page_template("https://vn.indeed.com/jobs?q=a&start=20&radius=25"))  # not page 2

    def test_indeed_reads_only_the_cards_a_person_can_see_and_names_a_job_by_its_id(self):
        # every page has a card that is never drawn, with a made-up id: a decoy
        self.assertIn("getClientRects().length > 0", self.INDEED.extract)
        self.assertIn("aria-hidden", self.INDEED.extract)
        self.assertEqual(
            tool.canonical_url("https://vn.indeed.com/viewjob?jk=636a85f7fba547af&from=serp&vjs=3"),
            "https://vn.indeed.com/viewjob?jk=636a85f7fba547af")
        self.assertNotEqual(  # two jobs with one title are two jobs
            tool.canonical_url("https://vn.indeed.com/viewjob?jk=aaa"), tool.canonical_url("https://vn.indeed.com/viewjob?jk=bbb"))
        self.assertEqual(tool.canonical_url("https://itviec.com/it-jobs/rust-dev-1?jk=zz&utm=1"), "https://itviec.com/it-jobs/rust-dev-1?jk=zz")

    def indeed_site(self, pages):
        search = "https://vn.indeed.com/jobs?q=software+engineer&l=Vietnam"
        later = "https://vn.indeed.com/jobs?q=software+engineer&l=Vietnam&start=%d&radius=25"
        site = {}
        for number in range(1, pages + 1):
            address = search if number == 1 else later % ((number - 1) * 10)
            cards = [card("Dev %d%s" % (number, letter), url="https://vn.indeed.com/viewjob?jk=%d%s" % (number, letter), company="Acme") for letter in "ab"]
            site[address] = {"cards": cards, "next": later % (number * 10) if number < pages else None, "total_pages": pages}
        return site

    def test_indeed_reads_its_pages_side_by_side_in_two_windows_at_most(self):
        site = self.indeed_site(9)
        context = FakeContext(site)
        jobs, result = self.crawl(
            FakePage(site), self.INDEED, "--my-chrome", "--keyword=software engineer", "--pages-at-once=5", context=context)
        self.assertEqual((result["status"], result["pages"], len(jobs)), ("ok", 9, 18))  # every page, once
        self.assertTrue(1 <= len(context.windows) <= 2)  # --pages-at-once=5, and Indeed gets no more than 2
        self.assertEqual(
            {address for window in context.windows for address in window.visited},
            {"https://vn.indeed.com/jobs?q=software+engineer&l=Vietnam&start=%d&radius=25" % (number * 10) for number in range(1, 9)})
        self.assertEqual(jobs[0]["url"].split("?")[0], "https://vn.indeed.com/viewjob")

    def test_a_window_limit_of_a_site_also_limits_the_windows_of_a_retry(self):
        site = self.indeed_site(9)
        later = "https://vn.indeed.com/jobs?q=software+engineer&l=Vietnam&start=40&radius=25"
        site = self.BlockedFirst(site, later, blocks=1)
        context = FakeContext(site)
        jobs, result = self.crawl(
            FakePage(site), self.INDEED, "--my-chrome", "--keyword=software engineer", "--pages-at-once=5", context=context)
        self.assertEqual((result["status"], result["pages"], len(jobs)), ("ok", 9, 18))
        self.assertLessEqual(len(context.windows), 2 + 2)  # the windows of a retry do not add to the 2 of the first pass

    def test_indeed_is_left_alone_for_longer_between_its_searches(self):
        site = {
            "https://vn.indeed.com/jobs?q=backend+developer&l=Vietnam": {"cards": [card("Backend Developer", url="https://vn.indeed.com/viewjob?jk=a")], "next": None},
            "https://vn.indeed.com/jobs?q=frontend+developer&l=Vietnam": {"cards": [card("Frontend Developer", url="https://vn.indeed.com/viewjob?jk=b")], "next": None},
        }
        waits = []
        with mock.patch.object(tool, "pause", side_effect=waits.append):
            jobs, result = self.crawl(FakePage(site), self.INDEED, "--role=Backend, Frontend", "--delay=4")
        self.assertEqual(sorted(job["title"] for job in jobs), ["Backend Developer", "Frontend Developer"])
        # one rest between the two searches, six times the delay; the rests between pages are the delay itself
        self.assertIn(4.0 * self.INDEED.search_pause, waits)
        self.assertEqual(self.INDEED.search_pause, 6.0)
        self.assertEqual(tool.SOURCES["itviec"].search_pause, 1.0)

    def test_the_page_count_readers_exist_for_the_four_boards_only(self):
        for name in ("itviec", "topcv", "careerviet", "indeed"):
            self.assertTrue(tool.SOURCES[name].total_pages.lstrip().startswith("() =>"))
        self.assertEqual(
            {name for name, source in tool.SOURCES.items() if source.total_pages}, {"itviec", "topcv", "careerviet", "indeed"})
        args = options(output_dir=self.root)
        self.assertEqual((args.sites_at_once, args.pages_at_once), (3, 5))  # up to 15 windows at the same time
        self.assertEqual(options("--pages-at-once=10", output_dir=self.root).pages_at_once, 10)
        for bad in ("--sites-at-once=0", "--sites-at-once=9", "--pages-at-once=0", "--pages-at-once=11"):
            with self.subTest(bad):
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    options(bad, output_dir=self.root)

    def test_a_closed_window_is_reported_as_closed_not_empty(self):
        for when in ("goto", "wait"):
            with self.subTest(when):
                page = FakePage({"https://itviec.com/it-jobs": {"cards": [card("Rust Dev")]}}, closed=when)
                jobs, result = self.crawl(page, ITVIEC)
                self.assertEqual((jobs, result["status"], result["message"]), ([], "error", tool.CLOSED_MESSAGE))

    def test_main_skips_the_remaining_sites_when_the_window_is_closed(self):
        code, report, _ = self.run_main({}, closed="goto")
        self.assertEqual(code, 1)
        self.assertEqual(report["sources"]["itviec"]["status"], "error")
        self.assertEqual(report["sources"]["topcv"]["status"], "skipped")
        self.assertEqual(report["sources"]["topcv"]["message"], tool.CLOSED_MESSAGE)

    def test_main_writes_the_csv_and_report_and_exits_0(self):
        site = {"https://itviec.com/it-jobs": {"cards": [card("Rust Dev")], "next": None}}
        code, report, run = self.run_main(site, "--sources=itviec", "--max-pages=1")
        self.assertEqual(code, 0)
        self.assertEqual(report["total_jobs"], 1)
        self.assertEqual(report["sources"]["itviec"]["status"], "ok")
        self.assertEqual(sorted(path.name for path in run.iterdir()), ["jobs.csv", "jobs.xlsx", "report.json"])

    def test_main_exits_1_and_keeps_a_screenshot_when_a_site_fails(self):
        site = {"https://itviec.com/it-jobs": {"status": 403, "title": "Attention Required! | Cloudflare", "cards": []}}
        code, report, run = self.run_main(site, "--sources=itviec")
        self.assertEqual(code, 1)
        self.assertEqual(report["total_jobs"], 0)
        self.assertEqual(report["sources"]["itviec"]["status"], "blocked")
        self.assertTrue((run / "screenshots" / "itviec-page1-blocked.png").exists())
        # nothing was collected, so there is no header-only sheet or CSV to mistake for a result
        self.assertEqual(sorted(path.name for path in run.iterdir()), ["report.json", "screenshots"])

    def run_main(self, site, *args, closed=None):
        page = self.last_page = FakePage(site, closed=closed)
        context = self.context = mock.Mock(pages=[], new_page=mock.Mock(return_value=page))
        playwright = mock.MagicMock()
        playwright.__enter__.return_value = object()
        with mock.patch.object(tool, "import_playwright", return_value=lambda: playwright), \
                mock.patch.object(tool, "launch", return_value=context), \
                contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            code = tool.main(["--output-dir=%s" % (self.root / "out"), "--own-browser", *args])  # not the Mac's Chrome
        context.close.assert_called_once()
        run = next((self.root / "out").iterdir())
        report = json.loads((run / "report.json").read_text(encoding="utf-8"))
        return code, report, run

    def test_main_on_a_mac_reads_in_your_chrome_with_the_profile_it_found(self):
        site = {"https://itviec.com/it-jobs": {"cards": [card("Rust Dev")], "next": None}}
        chrome = FakeContext(site)
        with mock.patch.object(tool.sys, "platform", "darwin"), \
                mock.patch.object(tool, "chrome_installed", return_value=True), \
                mock.patch.object(tool, "chrome_profiles_with_apple_events", return_value=["Profile 3"]), \
                mock.patch.object(tool, "connect_real_chrome", return_value=chrome) as connected, \
                mock.patch.object(tool, "import_playwright") as playwright, \
                contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            code = tool.main(["--output-dir=%s" % (self.root / "out"), "--sources=itviec"])  # no --my-chrome, no profile
        self.assertEqual(code, 0)
        connected.assert_called_once_with(quiet=True, profile="Profile 3")
        playwright.assert_not_called()  # nothing is installed or started
        report = json.loads(next((self.root / "out").iterdir()).joinpath("report.json").read_text(encoding="utf-8"))
        self.assertEqual((report["my_chrome"], report["chrome_profile"]), (True, "Profile 3"))
        self.assertEqual(report["total_jobs"], 1)


if __name__ == "__main__":
    unittest.main()
