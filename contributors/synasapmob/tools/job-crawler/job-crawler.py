#!/usr/bin/env python3
# job-crawler: collect IT job listings from job boards and company career pages into a spreadsheet on your computer
#
# Opens windows in your own Chrome (on a Mac; it finds the profile that has View > Developer > Allow JavaScript
# from Apple Events turned on), loads the job lists of ITviec, TopCV, CareerViet and the career
# pages of WorldQuant, Topicus Vietnam, Symbotic, Lecle Vietnam, Luce and Axon and reads
# the job cards each page renders: title, company, location, salary, experience, work model, posted
# age, skills and the link. It writes a dated folder with jobs.xlsx (click a job's title to open it),
# jobs.csv (the same jobs as plain text, with a url column) and report.json, which says for each site
# whether it finished, was blocked or came back empty, so you can see what was missed. --date (the
# last 30 days unless you say 60, 90 or 0 for all), --role, --company and --location keep only the
# jobs you want. The pages are read from the sites and the files stay on
# your computer; nothing is uploaded anywhere.
#
# Run it from Hub William (macOS or Linux, Python 3.9 or newer, Google Chrome recommended):
#   curl -fsSL https://hub-william.site/catalog/contributors/synasapmob/tools/job-crawler/job-crawler.py | python3 - --output-dir=~/Documents/jobs
# Or run a downloaded copy: python3 job-crawler.py --output-dir=~/Documents/jobs
# Narrow it: --keyword=python --sources=itviec --max-pages=5 (see --help for the rest).
#
# On a Mac with Chrome nothing is installed. If no profile has that setting on, the tool says where to
# turn it on and stops. --own-browser, --headless and computers that are not a Mac use a browser the
# tool starts itself: the first run installs Playwright into ~/.cache/hub-william/job-crawler
# (--cache-dir changes it) with pip, and downloads Chromium only when Google Chrome is not installed.
# That browser profile lives there, apart from your own Chrome profile, and it keeps a site's "you are
# human" clearance between runs. The tool never reads your cookies, never logs in, and does not try to
# get around a challenge: when Cloudflare asks for a human check it waits (up to --challenge-wait
# seconds) for you to complete it in the window. With --headless nothing can be clicked, so a check
# ends that site.
#
# Exit status: 0 when every site finished, 1 when a site did not (the files still hold what was
# collected) or the setup failed before anything was read, 2 for a wrong argument.

import argparse
import contextlib
import csv
import json
import os
import random
import re
import subprocess
import sys
import threading
import time
import unicodedata
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlencode, urlparse
from xml.sax.saxutils import escape, quoteattr

COLUMNS = [
    "source",
    "role",
    "title",
    "company",
    "location",
    "salary",
    "experience",
    "work_model",
    "posted",
    "url",
]
# The spreadsheet has no url column: the title is the link. A row also carries `tags` and `scraped_at`,
# which are not written: `tags` only feeds --keyword on a company page. `role` (see role_group) is the group
# of the title, written beside it because a spreadsheet's filter list shows what a column holds: it lists
# Backend and Fullstack here, while the title column keeps each title as the site wrote it.
SHEET_COLUMNS = [name for name in COLUMNS if name != "url"]
SHEET_WIDTHS = {
    "source": 12, "role": 18, "title": 52, "company": 34, "location": 22, "salary": 18, "experience": 14,
    "work_model": 12, "posted": 22,
}
MAX_HYPERLINK = 2000  # Excel refuses longer addresses
XML_INVALID = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")

DEFAULT_OUTPUT_DIR = "~/Documents/jobs"
DEFAULT_CACHE_DIR = "~/.cache/hub-william/job-crawler"
RENDER_WAIT = 20  # seconds a page gets to draw its job cards
MAX_PAGES = 200  # the most list pages read per site, whatever --max-pages says
CHALLENGE_MARKERS = (
    "just a moment",
    "performing security verification",
    "verify you are human",
    "checking your browser",
)
BLOCK_MARKERS = ("attention required", "you have been blocked", "access denied")
STATE_MESSAGES = {
    "blocked": "the site blocked this browser (Cloudflare or a rate limit)",
    "not_found": "the site answered 404 for the list page",
    "empty": "no job cards appeared",
}
CLOSED_MESSAGE = "the Chrome window was closed"
CLOSED_MARKERS = ("has been closed", "target closed")

# Replaced by Playwright's own Error class once Playwright is imported (see main).
PlaywrightError = Exception

# ITviec draws a job as a .job-card in its search list and as a .mini-job-card on a company page,
# where the company's name is only in the page heading and a card has no posted age or work model.
ITVIEC_EXTRACT = """() => {
  const clean = (el) => (el ? el.textContent.replace(/\\s+/g, " ").trim() : "");
  const onCompanyPage = location.pathname.startsWith("/companies/");
  const pageCompany = onCompanyPage ? clean(document.querySelector("h1")) : "";
  return [...document.querySelectorAll(".job-card, .mini-job-card")].map((card) => {
    const mini = card.classList.contains("mini-job-card");
    const link = card.querySelector("h3 a[href]");
    const company = [...card.querySelectorAll('a[href*="/companies/"]')].map(clean).find(Boolean);
    const salary = card.querySelector(".salary");
    const meta = mini ? null : card.querySelector("div.small-text.text-dark-grey");
    return {
      title: clean(link),
      url: link ? link.href : "",
      company: company || pageCompany,
      salary: salary && !salary.querySelector(".sign-in-view-salary") ? clean(salary) : "",
      work_model: clean(meta && meta.querySelector(".flex-shrink-0.text-rich-grey")),
      location: clean(mini ? card.querySelector("span.small-text.text-truncate") : meta && meta.querySelector(".text-truncate")),
      posted: mini ? "" : clean(card.querySelector("span.small-text")),
      tags: [...card.querySelectorAll("a.itag")].map(clean),
    };
  });
}"""

ITVIEC_NEXT = """() => {
  const link = document.querySelector('a[rel="next"]');
  return link ? link.href : null;
}"""

TOPCV_EXTRACT = """() => {
  const clean = (el) => (el ? el.textContent.replace(/\\s+/g, " ").trim() : "");
  return [...document.querySelectorAll(".job-item-search-result")].map((card) => {
    const link = card.querySelector("h3.title a[href]");
    const salary = card.querySelector(".title-salary") || card.querySelector(".salary");
    return {
      title: clean(link && link.querySelector("span")),
      url: link ? link.href : "",
      company: clean(card.querySelector(".company-name")),
      salary: clean(salary),
      location: [...card.querySelectorAll(".info .city-text")].map(clean).join("; "),
      experience: clean(card.querySelector("label.exp")),
      posted: clean(card.querySelector(".label-update")),
      tags: [...card.querySelectorAll(".box-icon .tag .item-tag")].map(clean),
    };
  });
}"""

TOPCV_NEXT = """() => {
  const link = document.querySelector('nav.box-pagination a[rel="next"]');
  return link ? link.getAttribute("data-href") || link.href : null;
}"""


# CareerViet's page links have no address (they are buttons), but a page number in the list address
# works: ...-c1-vi.html is page 1 and ...-c1-trang-2-vi.html is page 2, 50 jobs a page.
CAREERVIET_EXTRACT = """() => {
  const clean = (el) => (el ? el.textContent.replace(/\\s+/g, " ").trim() : "");
  return [...document.querySelectorAll(".job-item")].map((card) => {
    const link = card.querySelector(".title a.job_link");
    const updated = [...card.querySelectorAll(".time li")].map(clean).find((text) => text.startsWith("Cập nhật"));
    return {
      title: clean(link),
      url: link ? link.href : "",
      company: clean(card.querySelector("a.company-name")),
      salary: clean(card.querySelector(".salary")),
      location: [...card.querySelectorAll(".location li")].map(clean).join("; "),
      posted: updated || "",
      tags: [...card.querySelectorAll(".welfare li")].map(clean),
    };
  });
}"""

CAREERVIET_NEXT = """() => {
  const current = Number((location.pathname.match(/-trang-(\\d+)-vi\\.html$/) || [0, 1])[1]);
  const heading = document.querySelector("h1");
  const total = Number(((heading ? heading.textContent : "").match(/[\\d.,]+/) || ["0"])[0].replace(/[.,]/g, ""));
  if (!total || current * 50 >= total) return null;
  const base = location.pathname.replace(/-trang-\\d+-vi\\.html$/, "-vi.html");
  return location.origin + base.replace(/-vi\\.html$/, "-trang-" + (current + 1) + "-vi.html");
}"""


# How many list pages a site has, read from page 1. With it, and a page number in the address
# (...?page=2, ...-trang-2-vi.html), the other pages can be read side by side instead of one after another.
ITVIEC_TOTAL_PAGES = """() => {
  const heading = document.querySelector("h1");
  const total = Number(((heading ? heading.textContent : "").match(/[\\d.,]+/) || ["0"])[0].replace(/[.,]/g, ""));
  const size = document.querySelectorAll(".job-card").length;
  return total && size ? Math.ceil(total / size) : null;
}"""

TOPCV_TOTAL_PAGES = """() => {
  const text = ((document.querySelector("#job-listing-paginate-text") || {}).textContent || "").replace(/\\s+/g, " ");
  const match = text.match(/\\/\\s*(\\d+)\\s*trang/);
  return match ? Number(match[1]) : null;
}"""

CAREERVIET_TOTAL_PAGES = """() => {
  const heading = document.querySelector("h1");
  const total = Number(((heading ? heading.textContent : "").match(/[\\d.,]+/) || ["0"])[0].replace(/[.,]/g, ""));
  return total ? Math.ceil(total / 50) : null;
}"""

# A company's own career page is one list on one page. It does not name the company on each card, so
# the reader says it, and no page has a next page.
NO_NEXT = "() => null"

WORLDQUANT_EXTRACT = """() => {
  const clean = (el) => (el ? el.textContent.replace(/\\s+/g, " ").trim() : "");
  return [...document.querySelectorAll("a.jobs-accordion__link")].map((link) => ({
    title: clean(link.querySelector(".jobs-accordion__job-title")),
    url: link.href,
    company: "WorldQuant",
    location: clean(link.querySelector(".jobs-accordion__job-location")),
  }));
}"""

# Topicus Vietnam's cards have a "View Details" button instead of a link, so every title points
# at the careers page. A card reads "4-5 years • Nov 25, 2026", then type, place and team.
TOPICUS_EXTRACT = """() => {
  const clean = (el) => (el ? el.textContent.replace(/\\s+/g, " ").trim() : "");
  return [...document.querySelectorAll("article")].filter((card) => card.querySelector("h3")).map((card) => {
    // The line is "4-5 years • Nov 25, 2026", but a card with no experience has only the date.
    const parts = clean(card.querySelector("h3 + p")).split("•").map((part) => part.trim()).filter(Boolean);
    const posted = parts.find((part) => /\\b(19|20)\\d\\d\\b/.test(part)) || "";
    const experience = parts.find((part) => part !== posted) || "";
    const facts = [...card.querySelectorAll("span > span")].map(clean);
    return {
      title: clean(card.querySelector("h3")),
      url: location.origin + "/careers",
      company: "Topicus Vietnam",
      experience: experience,
      posted: posted,
      location: facts[1] || "",
      tags: [facts[0], facts[2]].filter(Boolean),
    };
  });
}"""

# Symbotic writes a place as "VNM Ho Chi Minh" or "USA Remote & Travel". All 138 jobs were on the
# page at once: its "Load More" button added none.
SYMBOTIC_EXTRACT = """() => {
  const clean = (el) => (el ? el.textContent.replace(/\\s+/g, " ").trim() : "");
  return [...document.querySelectorAll(".job")].map((card) => {
    const link = card.querySelector(".job__content-title a");
    const [category, place] = clean(card.querySelector(".job__content-meta")).split("|").map((part) => part.trim());
    return {
      title: clean(link),
      url: link ? link.href : "",
      company: "Symbotic",
      location: place || "",
      tags: category ? [category] : [],
    };
  });
}"""

# Lecle Vietnam groups its roles by team and gives a role no address and no place. Ho Chi Minh is
# the only Vietnam office on the page, so that is the place given.
LECLE_EXTRACT = """() => {
  const clean = (el) => (el ? el.textContent.replace(/\\s+/g, " ").trim() : "");
  return [...document.querySelectorAll(".opening-position__list > div")].flatMap((group) => {
    const team = clean(group.querySelector(".job-preview__title h3"));
    return [...group.querySelectorAll("ul.job-preview__opening-postions li h6")].map((title) => ({
      title: clean(title),
      url: location.origin + "/careers",
      company: "Lecle Vietnam",
      location: "Ho Chi Minh",
      tags: team ? [team] : [],
    }));
  });
}"""

# Luce lists its jobs in several countries on one page and gives a country, not a city, as the place.
# A card reads: title, department, then three tags in the order country, job type, salary.
LUCE_EXTRACT = """() => {
  const clean = (el) => (el ? el.textContent.replace(/\\s+/g, " ").trim() : "");
  return [...document.querySelectorAll("#Job-Opening .is-jobs-card")].map((card) => {
    const link = card.querySelector("a.a-button");
    const tags = [...card.querySelectorAll(".m-job-tag .a-text-body-sm")].map(clean);
    return {
      title: clean(card.querySelector(".a-text-label-sm")),
      url: link ? link.href : "",
      company: "Luce",
      location: tags[0] || "",
      salary: tags[2] || "",
      tags: [clean(card.querySelector(".is-cta2")), tags[1]].filter(Boolean),
    };
  });
}"""

# Axon's full list is 458 jobs behind a different pager, so the tool opens the list Axon's own
# "Work in Vietnam" link opens: Ho Chi Minh City, Vietnam and Vietnam-Remote.
AXON_EXTRACT = """() => {
  const clean = (el) => (el ? el.textContent.replace(/\\s+/g, " ").trim() : "");
  return [...document.querySelectorAll("#careers-all ul > li")].map((item) => {
    const link = item.querySelector('a[href^="/careers/job/"]');
    const parts = link ? [...link.querySelectorAll("p")].map(clean) : [];
    return { title: parts[0] || "", url: link ? link.href : "", company: "Axon", location: parts[1] || "" };
  }).filter((row) => row.url);
}"""

AXON_VIETNAM = (
    "https://www.axon.com/careers/all?greenhouse-jobs-index%5BrefinementList%5D%5Blocation.name%5D%5B0%5D="
    "Ho%20Chi%20Minh%20City%2C%20Vietnam&greenhouse-jobs-index%5BrefinementList%5D%5Blocation.name%5D%5B1%5D="
    "Vietnam-Remote#careers-all"
)


@dataclass(frozen=True)
class Source:
    name: str  # what --sources takes
    label: str  # what the source column shows
    host: str
    start_url: object  # keyword -> first list page
    card: str  # CSS selector of one job card
    keyword_input: str  # search box to type into, or "" when the keyword goes in the URL
    extract: str  # JavaScript returning one object per card
    next_page: str  # JavaScript returning the next page's URL or null
    company_search: bool  # whether searching a company's name finds that company's jobs
    no_results: str = ""  # CSS selector of the page's own "no jobs" message, when it has one
    searchable: bool = True  # False for a company's own page: --keyword then filters titles and tags
    total_pages: str = ""  # JavaScript returning how many list pages there are, when page numbers are in the address


def itviec_start(keyword):
    query = "?" + urlencode({"query": keyword}) if keyword else ""
    return "https://itviec.com/it-jobs" + query


def topcv_start(keyword):
    # The IT category as the TopCV home page links it. The same address without the query
    # string answered 404 in testing.
    return "https://www.topcv.vn/tim-viec-lam-cong-nghe-thong-tin-cr257?category_family=r257"


def careerviet_start(keyword):
    # A keyword page ("vietcombank" found Vietcombank's own jobs) covers every category; with no
    # keyword, the software IT category.
    if keyword:
        return "https://careerviet.vn/viec-lam/%s-k-vi.html" % quote("-".join(keyword.split()))
    return "https://careerviet.vn/viec-lam/cntt-phan-mem-c1-vi.html"


SOURCES = {
    # Searching an exact company name on ITviec opens that company's page with all its jobs, and
    # CareerViet's keyword search matches company names. TopCV's search box matches job titles:
    # "MB Bank" found no jobs there.
    "itviec": Source(
        "itviec", "ITviec", "itviec.com", itviec_start, ".job-card, .mini-job-card", "",
        ITVIEC_EXTRACT, ITVIEC_NEXT, True, total_pages=ITVIEC_TOTAL_PAGES,
    ),
    "topcv": Source(
        "topcv", "TopCV", "www.topcv.vn", topcv_start, ".job-item-search-result", "#keyword",
        TOPCV_EXTRACT, TOPCV_NEXT, False, total_pages=TOPCV_TOTAL_PAGES,
    ),
    "careerviet": Source(
        "careerviet", "CareerViet", "careerviet.vn", careerviet_start, ".job-item", "",
        CAREERVIET_EXTRACT, CAREERVIET_NEXT, True, total_pages=CAREERVIET_TOTAL_PAGES,
    ),
    # Companies' own career pages.
    "worldquant": Source(
        "worldquant", "WorldQuant", "www.worldquant.com", lambda keyword: "https://www.worldquant.com/career-listing/",
        "a.jobs-accordion__link", "", WORLDQUANT_EXTRACT, NO_NEXT, False, searchable=False,
    ),
    "topicus": Source(
        "topicus", "Topicus Vietnam", "www.topicus.vn", lambda keyword: "https://www.topicus.vn/careers",
        "article:has(h3)", "", TOPICUS_EXTRACT, NO_NEXT, False, searchable=False,
    ),
    "symbotic": Source(
        "symbotic", "Symbotic", "www.symbotic.com", lambda keyword: "https://www.symbotic.com/careers/jobs/",
        ".job", "", SYMBOTIC_EXTRACT, NO_NEXT, False, searchable=False,
    ),
    "lecle": Source(
        "lecle", "Lecle Vietnam", "www.lecle.vn", lambda keyword: "https://www.lecle.vn/careers/",
        "ul.job-preview__opening-postions li", "", LECLE_EXTRACT, NO_NEXT, False, searchable=False,
    ),
    "luce": Source(
        "luce", "Luce", "www.luce.sg", lambda keyword: "https://www.luce.sg/jobs",
        "#Job-Opening .is-jobs-card", "", LUCE_EXTRACT, NO_NEXT, False, searchable=False,
    ),
    "axon": Source(
        "axon", "Axon", "www.axon.com", lambda keyword: AXON_VIETNAM,
        '#careers-all ul > li:has(a[href^="/careers/job/"])', "", AXON_EXTRACT, NO_NEXT, False,
        no_results='#careers-all p:has-text("We cannot find any career")', searchable=False,
    ),
}


def log(message):
    print(message, file=sys.stderr, flush=True)


def clean(value):
    return " ".join(str(value or "").split())


def first_line(error):
    return clean(str(error).splitlines()[0] if str(error) else type(error).__name__)[:200]


def canonical_url(url):
    """The job's address without tracking parameters, so one job has one key. An `id`
    parameter stays: on some career pages (WorldQuant) it is what names the job."""
    parts = urlparse(str(url or "").strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return ""
    path = parts.path.rstrip("/") or "/"
    job_id = [value for name, value in parse_qsl(parts.query) if name == "id" and value][:1]
    return "https://%s%s%s" % (parts.hostname.lower(), path, "?" + urlencode({"id": job_id[0]}) if job_id else "")


def same_site(url, host):
    parts = urlparse(url)
    return parts.scheme == "https" and parts.hostname == host


# Vietnam's provinces and cities without accents. short_location tells a place from a district with it,
# and writes each one in a single spelling, so that "Đà Nẵng" (TopCV) and "Da Nang" (ITviec) are one entry
# in the sheet's filter list.
VIETNAM_PLACES = (
    "an giang", "bac giang", "bac kan", "bac can", "bac lieu", "bac ninh", "ben tre", "binh dinh", "binh duong",
    "binh phuoc", "binh thuan", "ca mau", "can tho", "cao bang", "da nang", "dak lak", "dac lak", "dak nong",
    "dac nong", "dien bien", "dong nai", "dong thap", "gia lai", "ha giang", "ha nam", "ha tinh", "hai duong",
    "hai phong", "hau giang", "hoa binh", "hue", "hung yen", "khanh hoa", "kien giang", "kon tum", "lai chau",
    "lam dong", "lang son", "lao cai", "long an", "nam dinh", "nghe an", "ninh binh", "ninh thuan", "phu tho",
    "phu yen", "quang binh", "quang nam", "quang ngai", "quang ninh", "quang tri", "soc trang", "son la",
    "tay ninh", "thai binh", "thai nguyen", "thanh hoa", "tien giang", "tra vinh", "tuyen quang", "vinh long",
    "vinh phuc", "yen bai",
)
_PLACE_NAMES = {
    "ho chi minh": "HCM", "ho chi minh city": "HCM", "hcm": "HCM", "hcmc": "HCM", "sai gon": "HCM",
    "saigon": "HCM", "ho chi minh metropolitan area": "HCM", "ho chi minh city metropolitan area": "HCM",
    "ha noi": "HN", "hanoi": "HN", "hn": "HN", "ha noi capital": "HN", "hanoi capital": "HN",
    "hanoi capital region": "HN", "ha noi capital region": "HN",
    "nuoc ngoai": "Overseas", "overseas": "Overseas", "abroad": "Overseas",
    "bariavungtau": "Ba Ria-Vung Tau", "thuathienhue": "Hue",
    **{name: name.title() for name in VIETNAM_PLACES},
}
_PLACE_NAMES["bac can"], _PLACE_NAMES["dac lak"], _PLACE_NAMES["dac nong"] = "Bac Kan", "Dak Lak", "Dak Nong"
_PLACE_FIRST = ("HN", "HCM", "Da Nang")  # the cities people filter on come first, the rest alphabetically
# "Quận 1", "Q.3", "District 7", "Huyện Củ Chi", "Phường 2", "TP Thủ Đức": a part of a city, not a place.
_DISTRICT = re.compile(
    r"^(?:quan|huyen|phuong|xa|thi xa|thi tran|district|ward|commune|thu duc|tp\.? ?thu duc|thanh pho thu duc)\b"
    r"|^[qpd]\.? ?\d{1,2}$")
_NO_PLACE = re.compile(r"^(?:\d+ )?(?:noi )?(?:khac|others?)$|^(?:vietnam|viet nam|vnm)$")  # "2 nơi khác", "Others"
_PLACE_SPLIT = re.compile(r"\s*[;,/&|]\s*|\s+[-–]\s*|\s*[-–]\s+|\s+(?:or|and)\s+", re.IGNORECASE)


def short_location(text):
    """The cities of a job in one spelling each: Ho Chi Minh City -> HCM, Hanoi -> HN, any other province
    without its accents ("Đà Nẵng" and "Da Nang" -> Da Nang), HN first, then HCM, Da Nang and the others
    alphabetically, with a comma between them. TopCV's "(mới)", "2 nơi khác" ("2 other places"), "Others",
    "Vietnam" and districts ("Quận 1", "Q3") are left out. A text with no Vietnamese place in it, such as
    "USA Remote & Travel", a bare "Vietnam" or "Singapore", is left as the site wrote it."""
    text = unicodedata.normalize("NFC", text)
    text = re.sub(r"\s*\(\s*(?:m[oớ]i|new)\s*\)", "", text, flags=re.IGNORECASE)  # TopCV's "(mới)", "new name"
    # two provinces that are written with a hyphen or as two words: keep each as one place
    protected = re.sub(r"B[àa]\s*R[ịi]a\s*(?:[-–,]\s*|\s+)V[ũu]ng\s*T[àa]u", "BaRiaVungTau", text, flags=re.IGNORECASE)
    protected = re.sub(r"Th[ừu]a\s*Thi[êe]n\s*[-–]?\s*Hu[ếe]", "ThuaThienHue", protected, flags=re.IGNORECASE)
    places, found = [], False
    for part in _PLACE_SPLIT.split(protected):
        part = clean(part).strip(" ,")
        key = re.sub(r"^(?:thanh pho|tp\.?|tinh|vnm) ?", "", fold(part)).strip()
        key = re.sub(r"\s+(?:quan|district|q|d|p|phuong|ward)\.? ?\d{1,2}$", "", key)  # "HCM Q1", "Ho Chi Minh District 7"
        if not key or _DISTRICT.match(key) or _NO_PLACE.match(key):
            continue
        name = _PLACE_NAMES.get(key)
        found = found or name is not None
        name = name or part
        if name and name not in places:  # "HCM, HCM" when a site lists both of its names for it
            places.append(name)
    if not found:
        return re.sub(r"\s*;\s*", ", ", text)  # several places are always separated by a comma
    return ", ".join(sorted(places, key=lambda name: (_PLACE_FIRST.index(name) if name in _PLACE_FIRST else len(_PLACE_FIRST), name)))


_NUMERIC_DATE = re.compile(r"\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b")  # 27-11-2026
_ENGLISH_DATE = re.compile(r"\b([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b")  # nov 25, 2026
_AGE = re.compile(r"\b(\d+|an?)\s*(minute|hour|day|week|month|year|phut|gio|ngay|tuan|thang|nam)s?\s*(?:ago|truoc)\b")
_MONTHS = {name: number for number, name in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), start=1)}
_UNITS = {
    "minute": timedelta(minutes=1), "phut": timedelta(minutes=1),
    "hour": timedelta(hours=1), "gio": timedelta(hours=1),
    "day": timedelta(days=1), "ngay": timedelta(days=1),
    "week": timedelta(weeks=1), "tuan": timedelta(weeks=1),
    "month": timedelta(days=30), "thang": timedelta(days=30),
    "year": timedelta(days=365), "nam": timedelta(days=365),
}


def read_posted(text, now):
    """The day a job's posted text names, and whether the page says it was edited: (date, bool).

    Sites write it as "27-11-2026", "Nov 25, 2026" or as an age ("Posted 3 days ago", "Đăng 1 tuần
    trước"); an age is counted back from now, so it is approximate. The day is None when the text
    has no date in it, or an impossible one."""
    folded = fold(text)
    day = None
    try:
        numeric, english, age = _NUMERIC_DATE.search(folded), _ENGLISH_DATE.search(folded), _AGE.search(folded)
        if numeric:
            day = date(int(numeric.group(3)), int(numeric.group(2)), int(numeric.group(1)))
        elif english and english.group(1)[:3] in _MONTHS:
            day = date(int(english.group(3)), _MONTHS[english.group(1)[:3]], int(english.group(2)))
        elif re.search(r"\b(hom nay|today|just now)\b", folded):
            day = now.date()
        elif re.search(r"\b(hom qua|yesterday)\b", folded):
            day = (now - timedelta(days=1)).date()
        elif age:
            count = 1 if age.group(1) in ("a", "an") else int(age.group(1))
            day = (now - count * _UNITS[age.group(2)]).date()
    except (ValueError, OverflowError):  # a date that does not exist: keep what the page said
        day = None
    edited = any(word in folded for word in ("cap nhat", "updated", "edited", "modified"))
    return day, edited


def format_posted(text, now):
    """The date a job shows as "Created at 30-10-2026", or "Edited at 30-10-2026" when the page says
    it was updated; the text as the page wrote it when there is no date in it."""
    if not fold(text):
        return ""
    day, edited = read_posted(text, now)
    if day is None:
        return clean(text)
    return "%s at %s" % ("Edited" if edited else "Created", day.strftime("%d-%m-%Y"))


_RANGE = re.compile(r"(\d+(?:[.,]\d+)?)\s*[-–—]\s*(\d+(?:[.,]\d+)?)\s*(?:years?|yrs?|nam)\b")
_COUNT = re.compile(r"(\d+(?:[.,]\d+)?)\s*(\+)?\s*(?:years?|yrs?|nam)\b")
_NO_EXPERIENCE = re.compile(
    r"khong yeu cau|khong can|chua co kinh nghiem|no experience|\bentry\b|\bfresher\b|fresh graduate|new grad"
    r"|\bgraduate\b|\bintern(?:ship)?\b")


def format_experience(text):
    """Experience as "4-5 years", "4 years", "5+ years", "Under 1 year" or "Entry-level".

    TopCV writes "2 năm", "Trên 5 năm" or "Không yêu cầu"; Topicus writes "4-5 years". Text that is
    none of these is left as the site wrote it."""
    folded = fold(text)
    if not folded:
        return ""
    if _NO_EXPERIENCE.search(folded):
        return "Entry-level"
    span = _RANGE.search(folded)
    if span:
        return "%s-%s years" % (span.group(1), span.group(2))
    count = _COUNT.search(folded)
    if count:
        number = count.group(1)
        if count.group(2) or re.search(r"\b(?:tren|over|more than|above)\b", folded):
            return "%s+ years" % number
        if re.search(r"\b(?:duoi|under|less than|below)\b", folded):
            return "Under %s %s" % (number, "year" if number == "1" else "years")
        return "%s %s" % (number, "year" if number == "1" else "years")
    return clean(text)


def clean_salary(text):
    """The amount without the label some sites put before it: "Lương: 15 - 25 Triệu VND" becomes
    "15 - 25 Triệu VND". Anything else, such as "Cạnh tranh" (competitive), is left as it is."""
    if squash(text) == squash("You'll love it"):  # ITviec's words for a salary the employer keeps private
        return ""
    label, colon, amount = text.partition(":")
    if colon and fold(label).strip() in ("luong", "salary"):
        return clean(amount)
    return text


def normalize(row, source, scraped_at, now=None):
    """One card from the page as a CSV row, or None when it has no title or link.

    `location` is the short form shown in the sheet; `location_raw` is what the page said, which
    the --location filter reads. `posted` is turned into a date by format_posted, and `posted_on` is
    that same day as a date (None when the page names none), which the --date filter reads."""
    now = now or datetime.now()
    title = clean(row.get("title"))
    url = canonical_url(row.get("url"))
    if not title or not url:
        return None
    tags = [clean(tag) for tag in row.get("tags") or []]
    return {
        "source": source,
        "role": role_group(title),
        "title": title,
        "company": clean(row.get("company")),
        "location": short_location(clean(row.get("location"))),
        "location_raw": clean(row.get("location")),
        "salary": clean_salary(clean(row.get("salary"))),
        "salary_level": (salary_level(clean_salary(clean(row.get("salary")))) or ("", None))[0],
        "experience": format_experience(clean(row.get("experience"))),
        "work_model": clean(row.get("work_model")),
        "posted": format_posted(clean(row.get("posted")), now),
        "posted_on": read_posted(clean(row.get("posted")), now)[0],
        "tags": "; ".join(tag for tag in tags if tag),
        "url": url,
        "scraped_at": scraped_at,
    }


def add_jobs(jobs, seen, rows):
    """Append the rows not seen before; return how many were added and how many repeated."""
    added = duplicates = 0
    for row in rows:
        # The title is part of the key because a career page with no address per job (Topicus)
        # points every title at the same page.
        key = (row["url"], row["title"])
        if key in seen:
            duplicates += 1
            continue
        seen.add(key)
        jobs.append(row)
        added += 1
    return added, duplicates


def spreadsheet_safe(value):
    """Stop a spreadsheet from running a cell that a site made start with = + - or @."""
    if value and value[0] in "=+-@\t\r":
        return "'" + value
    return value


def write_csv(path, jobs):
    # utf-8-sig: Excel only reads Vietnamese correctly when the file starts with a BOM.
    with open(path, "w", encoding="utf-8-sig", newline="") as handle:
        names = visible_columns(COLUMNS, jobs)
        writer = csv.DictWriter(handle, fieldnames=names, extrasaction="ignore")
        writer.writeheader()
        for job in jobs:
            writer.writerow({name: spreadsheet_safe(job.get(name, "")) for name in names})


def fold(text):
    """Lower case without accents, so "Hà Nội" and "ha noi" are the same place."""
    text = unicodedata.normalize("NFKD", str(text).replace("đ", "d").replace("Đ", "D"))
    return "".join(char for char in text if not unicodedata.combining(char)).lower()


# Every way the sites write Ho Chi Minh City: "Ho Chi Minh" (ITviec), "Hồ Chí Minh (mới)" (TopCV),
# "VNM Ho Chi Minh" (Symbotic), "Hanoi or Ho Chi Minh City, Vietnam" (WorldQuant).
HO_CHI_MINH = ("ho chi minh", "hcm", "sai gon", "saigon")


HA_NOI = ("ha noi", "hanoi")


def location_words(term):
    """What to look for in a job's place for one --location value."""
    folded = fold(term)
    if any(word in folded for word in HO_CHI_MINH):  # "Ho Chi Minh City", "HCMC", "Saigon"
        return list(HO_CHI_MINH)
    if re.fullmatch(r"(?:ha ?noi|hn)(?: city| capital(?: region)?)?", folded):  # "Hanoi", "HN"
        return list(HA_NOI)
    return [folded]


def squash(text):
    """Letters and digits only, so "Front-end", "Frontend" and "front end" are one word."""
    return re.sub(r"[^a-z0-9]+", "", fold(text))


# Spellings of one job that squashing does not make equal.
ROLE_ALSO = {
    "softwareengineer": ("softwaredeveloper",),
    "solutionengineer": ("solutionsengineer",),
}


# "Mobile" alone is in marketing, design and analyst titles ("Marketing (Mobile App)", "UI/UX Designer
# – Mobile app"), so it means a mobile developer: a mobile word near a developer word, either way round.
_MOBILE_ROLE = tuple(re.compile(pattern) for pattern in (
    r"\b(?:mobile|android|ios|flutter|react[\s\-]?native)\b[^,;()\[\]]{0,30}\b(?:developer|engineer|dev|programmer|architect)\b",
    r"\b(?:developer|engineer|dev|programmer)\b[^,;()\[\]]{0,20}\bmobile\b",
))


@lru_cache(maxsize=None)
def role_patterns(term):
    """Patterns that find a job role in a title, whatever separates its words.

    "Back-end" becomes back, then an optional space or hyphen, then end, as whole words: it finds
    "Back-end Developer" and "Backend Engineer" but not "Backendless"."""
    if squash(term) == "mobile":
        return _MOBILE_ROLE
    forms = [squash(term)] + list(ROLE_ALSO.get(squash(term), ()))
    return tuple(
        re.compile(r"\b" + r"[\s\-_/]?".join(re.escape(char) for char in form) + r"\b") for form in forms if form)


# The order the groups come in the sheet.
ROLE_GROUPS = (
    "Software Engineer", "Fullstack", "Frontend", "Backend", "Mobile",
    "Product Owner", "Product Manager", "Solution Engineer",
)


# A stack that only runs on the server, next to a plain "Developer" or "Engineer", makes a Backend job:
# ".NET Developer", "Senior Java Engineer", "PHP Programmer". Titles about data, testing, operations and the
# like with such a word in them ("Data Engineer (Python)", "QA Engineer (Java)") are not.
_BACKEND_STACK = re.compile(
    r"(?<![a-z0-9])(?:\.net|dotnet|asp\.net|c#|java|php|python|golang|node\.?js|ruby|rails|laravel|spring|django)"
    r"(?![a-z0-9#])")
_DEVELOPER = re.compile(r"\b(?:developers?|engineers?|devs?|programmers?|lap trinh vien)\b")
_NOT_BACKEND = re.compile(
    r"\b(?:data|machine learning|ml|ai|devops|qa|qc|test|tester|testing|security|embedded|firmware|sre|reliability"
    r"|support|analyst|bi|etl|designer|sales|consultant|trainer|game|unity|blockchain|erp|odoo|automation)\b"
    r"|low[\s\-]?code")


def role_group(title):
    """The one group a job belongs to. Each job's group is written to the `role` column, so that the
    sheet's filter lists the groups, and it orders the rows, so that every Backend title sits together
    whatever the stack or the spelling.

    "Back End Developer (C#)", "Backend .NET Developer", ".NET Developer" and "Java Engineer" are all
    `Backend`; "Android Developer", "iOS Engineer" and "Flutter Developer" are all `Mobile`. Level and
    stack words are ignored. A title that names both Backend and Frontend is `Fullstack`. A title in
    none of the groups gets an empty group."""
    text = fold(title)

    def has(term):
        return any(pattern.search(text) for pattern in role_patterns(term))

    backend, frontend = has("Back-end"), has("Front-end")
    if has("Fullstack") or (backend and frontend):
        return "Fullstack"
    if any(pattern.search(text) for pattern in _MOBILE_ROLE):  # Android, iOS, Flutter, React Native, Mobile
        return "Mobile"
    if backend:
        return "Backend"
    if frontend:
        return "Frontend"
    for group in ("Solution Engineer", "Product Owner", "Product Manager", "Software Engineer"):
        if has(group):
            return group
    if _BACKEND_STACK.search(text) and _DEVELOPER.search(text) and not _NOT_BACKEND.search(text):
        return "Backend"
    return ""


# What --role says for each group, as squash() writes it.
ROLE_OF_TERM = {
    "softwareengineer": "Software Engineer", "fullstack": "Fullstack", "frontend": "Frontend", "backend": "Backend",
    "mobile": "Mobile", "productowner": "Product Owner", "productmanager": "Product Manager",
    "solutionengineer": "Solution Engineer",
}


def sort_jobs(jobs):
    """Group by role, in the order of ROLE_GROUPS, then by company and title, so a group is together."""
    def key(job):
        group = job.get("role", "")
        return (ROLE_GROUPS.index(group) if group in ROLE_GROUPS else len(ROLE_GROUPS), fold(job["company"]), fold(job["title"]))

    return sorted(jobs, key=key)


def posted_within(row, days, today=None):
    """Whether a job was posted, or last edited, in the last `days` days. A job whose page names no
    date passes: nothing says it is old."""
    day = row.get("posted_on")
    if day is None:
        return True
    return (today or date.today()) - day <= timedelta(days=days)


def matches(row, options):
    """Whether a job passes --date, --company, --location and --role; several values mean any of them.

    A location is looked for in the job's location and its work model, because ITviec shows
    "Remote" as a work model, not as a place. A role is looked for in the title, and a job whose group
    is that role passes too (a ".NET Developer" title never says Backend, but its group is Backend)."""
    if options.date and not posted_within(row, options.date):
        return False
    if options.role:
        groups = {ROLE_OF_TERM[squash(term)] for term in options.role if squash(term) in ROLE_OF_TERM}
        if not (row.get("role") in groups or any(
                pattern.search(fold(row["title"])) for term in options.role for pattern in role_patterns(term))):
            return False
    if options.company and not any(fold(term) in fold(row["company"]) for term in options.company):
        return False
    if options.location:
        place = fold("%s %s" % (row.get("location_raw", row["location"]), row.get("work_model", "")))
        if not any(word in place for term in options.location for word in location_words(term)):
            return False
    return True


def xml_text(value):
    return escape(XML_INVALID.sub("", value))


def sheet_cell(column, row, text, style=0):
    style = ' s="%d"' % style if style else ""
    return '<c r="%s%d" t="inlineStr"%s><is><t xml:space="preserve">%s</t></is></c>' % (
        chr(ord("A") + column), row, style, xml_text(text))


def visible_columns(names, jobs):
    """Leave out `source` when it only repeats `company`, as it does on a company's own career page."""
    informative = any(job["source"] != job["company"] for job in jobs)
    return [name for name in names if name != "source" or informative]


EXCEL_EPOCH = date(1899, 12, 30)  # day 0 of Excel's dates
MILLION_DONG_PER_USD = 0.025  # 25,000 dong to the dollar; only used to put dollar and dong salaries in one order
# Excel keeps about 206 custom number formats in a workbook and shows General for the others (measured on
# 2026-11-27 with 288 in a sheet of 1304 jobs: 99 salary cells lost their text), so the sheet stays under this.
# The levels, the experience texts and the two date formats come to about 30.
MAX_NUMBER_FORMATS = 190


def parse_amount(token):
    """"1,000" and "1.000.000" are thousands; "3,5" and "1.5" have a decimal part."""
    if re.fullmatch(r"\d{1,3}(?:[.,]\d{3})+", token):
        return float(re.sub(r"[.,]", "", token))
    return float(token.replace(",", "."))


def salary_amount(text):
    """A number to order a salary by, in millions of dong: its top amount, with dollars converted. A
    salary that names no amount ("Thoả thuận", "Competitive") is 0, so it sorts apart from the ones that
    do; None for no salary at all, which a spreadsheet always sorts last."""
    folded = fold(text)
    if not folded:
        return None
    amounts = []
    for token in re.findall(r"\d[\d.,]*\d|\d", folded):
        try:
            amounts.append(parse_amount(token))
        except ValueError:
            pass
    if not amounts:
        return 0.0
    top = max(amounts)
    if re.search(r"usd|\$|us dollar", folded):
        top *= MILLION_DONG_PER_USD
    elif top >= 100000:  # dong written in full
        top /= 1000000
    return round(top, 3)


# The sheet's salary column shows a level and not the salary, because a spreadsheet's filter list shows one
# entry for every different text in a column: 278 salary texts in a 1304-job run, "10 - 15 triệu" and
# "10 - 15 Triệu VND" apart. The CSV keeps the exact text. A level holds the number that sorts it.
SALARY_LEVELS = (  # (the top amount is at most, label), in millions of dong
    (10, "Up to 10 triệu"), (20, "10 - 20 triệu"), (30, "20 - 30 triệu"), (50, "30 - 50 triệu"),
    (100, "50 - 100 triệu"),
)
SALARY_OVER = "Over 100 triệu"
SALARY_WORDS = (  # (label, number, folded words that say it), in the order they are looked for
    ("Không lương", -3, ("khong luong", "unpaid", "no salary")),
    ("Thoả thuận", -1, ("thoa thuan", "thuong luong", "negotiab", "negotiat", "discuss")),
    ("Cạnh tranh", -2, ("canh tranh", "competitive", "attractive", "hap dan", "high paid")),
)
SALARY_OTHER = ("Khác", -4)  # text that says nothing about the amount, in any of the ways above


def salary_level(text):
    """(level, number) of a salary: "Thoả thuận" (negotiable) -1, "Cạnh tranh" (competitive) -2, "Không lương"
    (no pay) -3, "Khác" (other text) -4, or a range of top amounts, "10 - 20 triệu", with that amount as its
    number, so that the level filters and the number sorts, lowest or highest first. None for no salary."""
    amount = salary_amount(text)
    if amount is None:
        return None
    if re.search(r"\d", text):
        for limit, label in SALARY_LEVELS:
            if amount <= limit:
                return label, amount
        return SALARY_OVER, amount
    folded = fold(text)
    for label, number, words in SALARY_WORDS:
        if any(word in folded for word in words):
            return label, float(number)
    return SALARY_OTHER[0], float(SALARY_OTHER[1])


def experience_years(text):
    """The years a job asks for as one number to order by, from the text format_experience wrote: "Entry-level"
    is 0, "Under 1 year" 0.5, "4 years" 4, "4-5 years" 4.5 and "5+ years" 5.25; None for any other text."""
    if text == "Entry-level":
        return 0.0
    number = r"(\d+(?:[.,]\d+)?)"
    for pattern, value in (
        (r"Under %s years?" % number, lambda found: found[0] - 0.5),
        (r"%s\+ years?" % number, lambda found: found[0] + 0.25),
        (r"%s-%s years?" % (number, number), lambda found: (found[0] + found[1]) / 2),
        (r"%s years?" % number, lambda found: found[0]),
    ):
        match = re.fullmatch(pattern, text)
        if match:
            return value([float(group.replace(",", ".")) for group in match.groups()])
    return None


class SheetStyles:
    """The cell formats of a sheet: three fixed ones, then one per display format a typed cell needs.

    A spreadsheet sorts a column by what its cells hold and lists in its filter what they show. So a date or
    a number is stored as one, and a number format that is only text makes it show words of its own:
    experience "4-5 years" is the number 4.5 shown as `"4-5 years"`, and the salary level "10 - 20 triệu"
    is the top amount, 15, shown as `"10 - 20 triệu"`; it sorts as 4.5 and 15."""

    FIXED = 3

    def __init__(self):
        self.codes = {}  # number format code -> its xf index

    def index(self, code):
        if code not in self.codes and len(self.codes) >= MAX_NUMBER_FORMATS:
            return None
        return self.codes.setdefault(code, self.FIXED + len(self.codes))

    def number_formats(self):
        return "".join(
            '<numFmt numFmtId="%d" formatCode=%s/>' % (163 + position, quoteattr(code))
            for position, code in enumerate(self.codes, start=1))

    def cell_formats(self):
        return "".join(
            '<xf numFmtId="%d" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1">'
            '<alignment horizontal="left"/></xf>' % (163 + position)
            for position, _ in enumerate(self.codes, start=1))


def literal_format(text):
    """A number format that shows `text` whatever the number is; None when the text is too long for one."""
    text = text.replace('"', "'")
    return '"%s"' % text if len(text) <= 200 else None


def sheet_text(name, job):
    """What a text cell of the sheet holds: the salary column holds the level, the others their own text."""
    return job.get("salary_level") or job.get("salary", "") if name == "salary" else job.get(name, "")


def typed_cell(column, row, name, job, styles):
    """A date, or a number that shows the page's own words, for `posted`, `experience` and `salary` (its
    level); None when the value is not one of those or cannot be written as one, and the cell is then plain
    text."""
    text = job.get(name, "")
    value = code = None
    label = next((word for word in ("Created at ", "Edited at ") if text.startswith(word)), None)
    if name == "posted" and isinstance(job.get("posted_on"), date) and label:
        value, code = (job["posted_on"] - EXCEL_EPOCH).days, '"%s"dd-mm-yyyy' % label
    elif name == "experience":
        value, code = experience_years(text), literal_format(text)
    elif name == "salary":
        level = salary_level(job.get("salary", ""))
        shown = literal_format(level[0]) if level else None
        # two sections: the second is for the negative numbers of the levels with no amount, so that "Thoả thuận"
        # is not shown as "-Thoả thuận" (Excel puts the minus sign in front of a negative number's single format)
        value, code = (level[1], "%s;%s" % (shown, shown)) if shown else (None, None)
    if value is None or code is None:
        return None
    style = styles.index(code)
    if style is None:
        return None
    return '<c r="%s%d" s="%d"><v>%s</v></c>' % (chr(ord("A") + column), row, style, repr(value))


def write_xlsx(path, jobs):
    """A one-sheet workbook: the title of each job is a link to it, with a frozen header and a filter."""
    namespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    relationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package = "http://schemas.openxmlformats.org/package/2006/relationships"
    names = visible_columns(SHEET_COLUMNS, jobs)
    styles = SheetStyles()
    header = "".join(sheet_cell(index, 1, name, 2) for index, name in enumerate(names))
    rows, links = ['<row r="1">%s</row>' % header], []
    for number, job in enumerate(jobs, start=2):
        cells = []
        for index, name in enumerate(names):
            text = sheet_text(name, job)
            if not text:
                continue
            typed = typed_cell(index, number, name, job, styles)
            if typed:
                cells.append(typed)
                continue
            linked = name == "title" and 0 < len(job.get("url", "")) <= MAX_HYPERLINK
            if linked:
                links.append((number, job["url"]))
            cells.append(sheet_cell(index, number, text, 1 if linked else 0))
        rows.append('<row r="%d">%s</row>' % (number, "".join(cells)))
    last = chr(ord("A") + len(names) - 1)
    columns = "".join(
        '<col min="%d" max="%d" width="%d" customWidth="1"/>' % (index + 1, index + 1, SHEET_WIDTHS[name])
        for index, name in enumerate(names))
    title = names.index("title")
    hyperlinks = "".join(
        '<hyperlink ref="%s%d" r:id="rId%d"/>' % (chr(ord("A") + title), number, position)
        for position, (number, _) in enumerate(links, start=1))
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="%s" xmlns:r="%s">'
        '<sheetViews><sheetView workbookViewId="0">'
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        '<selection pane="bottomLeft"/></sheetView></sheetViews>'
        '<cols>%s</cols><sheetData>%s</sheetData><autoFilter ref="A1:%s%d"/>%s</worksheet>'
    ) % (namespace, relationships, columns, "".join(rows), last, len(jobs) + 1,
         "<hyperlinks>%s</hyperlinks>" % hyperlinks if links else "")
    sheet_links = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="%s">%s</Relationships>'
    ) % (package, "".join(
        '<Relationship Id="rId%d" Type="%s/hyperlink" Target=%s TargetMode="External"/>'
        % (position, relationships, quoteattr(url)) for position, (_, url) in enumerate(links, start=1)))
    parts = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            '</Types>'),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="%s">'
            '<Relationship Id="rId1" Type="%s/officeDocument" Target="xl/workbook.xml"/></Relationships>'
        ) % (package, relationships),
        "xl/workbook.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="%s" xmlns:r="%s"><sheets><sheet name="Jobs" sheetId="1" r:id="rId1"/></sheets>'
            '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'
            'Jobs!$A$1:$%s$%d</definedName></definedNames></workbook>'
        ) % (namespace, relationships, last, len(jobs) + 1),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="%s">'
            '<Relationship Id="rId1" Type="%s/worksheet" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Type="%s/styles" Target="styles.xml"/></Relationships>'
        ) % (package, relationships, relationships),
        "xl/styles.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="%s">'
            '%s'
            '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>'
            '<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font>'
            '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
            '<fills count="2"><fill><patternFill patternType="none"/></fill>'
            '<fill><patternFill patternType="gray125"/></fill></fills>'
            '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            '<cellXfs count="%d"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
            '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
            '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>%s</cellXfs>'
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
            '</styleSheet>'
        ) % (namespace,
             '<numFmts count="%d">%s</numFmts>' % (len(styles.codes), styles.number_formats()) if styles.codes else "",
             SheetStyles.FIXED + len(styles.codes), styles.cell_formats()),
        "xl/worksheets/sheet1.xml": sheet,
    }
    if links:
        parts["xl/worksheets/_rels/sheet1.xml.rels"] = sheet_links
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in parts.items():
            archive.writestr(name, content)


def classify(title, text, status):
    """What a page with no job cards is: challenge, blocked, not_found or pending."""
    seen = ("%s\n%s" % (title, text)).lower()
    if any(marker in seen for marker in BLOCK_MARKERS):
        return "blocked"
    if any(marker in seen for marker in CHALLENGE_MARKERS):
        return "challenge"
    if status == 404:
        return "not_found"
    if status in (403, 429, 503):
        return "blocked"
    return "pending"


def is_closed(error):
    return any(marker in str(error).lower() for marker in CLOSED_MARKERS)


def read_state(page, source, status):
    try:
        if page.locator(source.card).count():
            return "ok"
        if source.no_results and page.locator(source.no_results).count():
            return "none"
        title = page.title()
        text = page.evaluate("() => (document.body ? document.body.innerText : '').slice(0, 3000)")
    except PlaywrightError as error:
        # Otherwise the page is navigating, for example after a human check.
        return "closed" if is_closed(error) else "pending"
    return classify(title, text, status)


def wait_for_cards(page, source, options, status=None):
    """Wait for job cards; give a human check time to be completed. Return (state, message).

    A quiet window is brought forward while a person has to click a check, and put back after."""
    brought_forward = []
    try:
        return _wait_for_cards(page, source, options, status, brought_forward)
    finally:
        if brought_forward and hasattr(page, "hide"):
            try:
                page.hide()
            except PlaywrightError:
                pass


def _wait_for_cards(page, source, options, status, brought_forward):
    started = time.monotonic()
    human_deadline = started + options.challenge_wait
    render_deadline = started + RENDER_WAIT
    announced = False
    while True:
        state = read_state(page, source, status)
        if state in ("ok", "none"):
            return state, ""
        if state == "closed":
            return "error", CLOSED_MESSAGE
        if state in ("blocked", "not_found"):
            return state, STATE_MESSAGES[state]
        now = time.monotonic()
        if state == "challenge":
            status = None
            if options.headless:
                return "challenge", "Cloudflare asked for a human check; run again without --headless"
            if now > human_deadline:
                return "challenge", "the human check was not completed within %d s" % options.challenge_wait
            if not announced:
                log("[%s] Cloudflare is checking this browser. Complete the check in the Chrome "
                    "window; waiting up to %d s." % (source.name, options.challenge_wait))
                announced = True
                if hasattr(page, "show"):
                    try:
                        page.show()
                        brought_forward.append(True)
                    except PlaywrightError:
                        pass
            render_deadline = now + RENDER_WAIT
        elif now > render_deadline:
            return "empty", STATE_MESSAGES["empty"]
        time.sleep(1)


def open_page(page, source, url, options):
    try:
        response = page.goto(url, wait_until="domcontentloaded", timeout=60000)
    except PlaywrightError as error:
        return "error", CLOSED_MESSAGE if is_closed(error) else first_line(error)
    asked, landed = urlparse(url).hostname or "", urlparse(page.url).hostname or ""
    if landed.removeprefix("www.") != asked.removeprefix("www."):
        # Seen when the page before this one asks "leave this page?" and the answer is no.
        return "error", "the browser stayed on %s instead of opening %s" % (landed or "the previous page", asked)
    return wait_for_cards(page, source, options, response.status if response else None)


def search_by_form(page, source, options, keyword):
    """Type the keyword into the site's search box and press Enter, as a person would."""
    before = page.url
    try:
        page.fill(source.keyword_input, keyword)
        page.press(source.keyword_input, "Enter")
        page.wait_for_url(lambda url: url != before, timeout=30000)
    except PlaywrightError as error:
        return "error", "could not use the search box: " + first_line(error)
    return wait_for_cards(page, source, options)


def next_page_url(page, source):
    try:
        url = page.evaluate(source.next_page)
    except PlaywrightError:
        return None
    return url if url and same_site(url, source.host) else None


def snapshot(page, run_dir, name):
    """A screenshot of what the page showed, kept as evidence of a failure."""
    try:
        folder = run_dir / "screenshots"
        folder.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(folder / (name + ".png")))
    except Exception:  # evidence is best effort and must not hide the real failure
        pass


def pause(seconds):
    time.sleep(seconds + random.uniform(0, seconds / 2))


def new_result():
    return {
        "status": "ok", "pages": 0, "jobs": 0, "duplicates": 0, "filtered_out": 0,
        "more_pages": False, "no_jobs_for": [], "message": "",
    }


def search_terms(source, options):
    """The searches to run on a site: --keyword, else each --company where the site can find
    a company by name, else the whole list ("")."""
    if options.keyword:
        return [options.keyword] if source.searchable else [""]
    if source.company_search and options.company:
        return list(options.company)
    return [""]


_LOCK = threading.RLock()  # jobs, seen and a site's result are shared by the windows reading it


def read_rows(page, source):
    """The jobs on the page that is open: (state, message, rows)."""
    cards = page.evaluate(source.extract)
    scraped_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = [row for row in (normalize(card, source.label, scraped_at) for card in cards) if row]
    if cards and not rows:
        return "unreadable", "job cards were found but no title and link could be read; the page markup may have changed", []
    return "ok", "", rows


def record_rows(source, options, term, number, rows, jobs, seen, result):
    """Filter one page's jobs, add them and count them; return how many passed the filters."""
    kept = [row for row in rows if matches(row, options)]
    if options.keyword and not source.searchable:  # a company's page has no search box
        kept = [row for row in kept if fold(options.keyword) in fold("%s %s" % (row["title"], row["tags"]))]
    with _LOCK:
        added, duplicates = add_jobs(jobs, seen, kept)
        result["pages"] += 1
        result["jobs"] += added
        result["duplicates"] += duplicates
        result["filtered_out"] += len(rows) - len(kept)
    log("[%s] %spage %d: %d jobs (%d repeated, %d filtered out)" % (
        source.name, "%r " % term if term else "", number, added, duplicates, len(rows) - len(kept)))
    return len(kept)


def fail_page(page, source, run_dir, result, number, state, message):
    with _LOCK:
        if result["status"] == "ok":  # the first failure is the one reported
            result["status"], result["message"] = state, message
    snapshot(page, run_dir, "%s-page%d-%s" % (source.name, number, state))
    log("[%s] page %d: %s (%s)" % (source.name, number, state, message))


def page_template(url):
    """From the address of page 2, a function that makes the address of page N; None if it has no number."""
    for pattern in (r"([?&]page=)2(?=&|#|$)", r"(-trang-)2(?=-)"):  # ?page=2 (ITviec, TopCV), -trang-2- (CareerViet)
        if re.search(pattern, url):
            return lambda number, pattern=pattern: re.sub(
                pattern, lambda found: "%s%d" % (found.group(1), number), url, count=1)
    return None


def remaining_pages(page, source, next_url, limit):
    """Pages 2 to N as (number, address) pairs, and whether --max-pages cut the list short; None when
    the site's page count or page addresses cannot be worked out, and the pages are read one by one."""
    if not source.total_pages:
        return None
    try:
        total = page.evaluate(source.total_pages)
    except PlaywrightError:
        return None
    template = page_template(next_url)
    if not isinstance(total, int) or total < 2 or template is None:
        return None
    last = min(total, limit)
    return [(number, template(number)) for number in range(2, last + 1)], total > last


BLOCK_COOLDOWN = 60  # seconds a site that blocked the windows is left alone before the pages left are read again
RETRY_WINDOWS = 2  # and the windows that read them


def crawl_pages_side_by_side(context, source, options, term, pages, jobs, seen, run_dir, result):
    """Read pages, a list of (number, address), in --pages-at-once windows at the same time.

    Returns how many jobs passed the filters. When the site blocks the windows (TopCV did, with 5 windows,
    after about 10 pages, and let a single window read on a minute later), the windows are closed, the site
    is left alone for BLOCK_COOLDOWN seconds, and the pages that were not read are read with
    RETRY_WINDOWS windows, once. A second block ends the site, and the jobs already read are kept."""
    done = set()  # the numbers of the pages that were read
    kept = _read_pages(context, source, options, term, pages, options.pages_at_once, jobs, seen, run_dir, result, done)
    left = [item for item in pages if item[0] not in done]
    if left and result["status"] == "blocked":
        log("[%s] blocked: waiting %d s, then reading the %d pages left with %d windows" % (
            source.name, BLOCK_COOLDOWN, len(left), min(RETRY_WINDOWS, options.pages_at_once)))
        time.sleep(BLOCK_COOLDOWN)
        with _LOCK:
            result["status"], result["message"] = "ok", ""  # a second block is reported in its turn
        kept += _read_pages(
            context, source, options, term, left, min(RETRY_WINDOWS, options.pages_at_once), jobs, seen, run_dir,
            result, done)
    return kept


def _read_pages(context, source, options, term, pages, workers, jobs, seen, run_dir, result, done):
    """One pass over pages with `workers` windows at the same time. The first failure stops new pages from
    starting. Each worker opens one window and reuses it for all its pages, so a run opens a few windows
    instead of one per page; they are closed together at the end."""
    stop = threading.Event()
    local = threading.local()
    opened = []

    def window():
        if getattr(local, "page", None) is None:
            local.page = context.new_page()
            with _LOCK:
                opened.append(local.page)
        return local.page

    def read(item):
        number, address = item
        if stop.is_set():
            return 0
        try:
            page = window()
            state, message = open_page(page, source, address, options)
            if state == "empty":
                # The site counted this page, so a blank list is more often a hiccup than the end of the list
                # (CareerViet gave two blank pages in one run, and the same pages had 50 jobs a minute later).
                pause(options.delay * 2)
                state, message = open_page(page, source, address, options)
            rows = []
            if state == "ok":
                state, message, rows = read_rows(page, source)
            if state != "ok":
                stop.set()
                fail_page(page, source, run_dir, result, number, state, message)
                return 0
            kept = record_rows(source, options, term, number, rows, jobs, seen, result)
            done.add(number)
        except PlaywrightError as error:
            stop.set()
            fail_page(getattr(local, "page", None), source, run_dir, result, number, "error",
                      CLOSED_MESSAGE if is_closed(error) else first_line(error))
            local.page = None  # a window that failed is not used again
            return 0
        pause(options.delay)  # each window rests between its pages, as one window would
        return kept

    try:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            return sum(pool.map(read, pages))
    finally:
        for page in opened:
            try:
                page.close()
            except PlaywrightError:
                pass


def crawl_search(page, source, options, term, jobs, seen, run_dir, result, context=None):
    """Read up to --max-pages pages of one search into jobs; return how many jobs passed the filters.

    A failure sets result["status"]. A search that finds nothing for a company is not a
    failure: it returns 0 and the caller notes it. With a context, --my-chrome and --pages-at-once,
    pages 2 to N of a site whose addresses carry the page number are read side by side."""
    url = source.start_url(term)
    limit = options.max_pages or MAX_PAGES
    read = 0
    for number in range(1, limit + 1):
        state, message = open_page(page, source, url, options)
        if state == "none":  # the page itself says it has no open roles: not a failure
            log("[%s] no open roles listed" % source.name)
            return 0
        if state == "ok" and number == 1 and term and source.keyword_input:
            state, message = search_by_form(page, source, options, term)
        rows = []
        if state == "ok":
            state, message, rows = read_rows(page, source)
        if state in ("empty", "not_found") and term and number == 1:
            log("[%s] %r: no jobs found" % (source.name, term))
            return 0
        if state != "ok":
            fail_page(page, source, run_dir, result, number, state, message)
            return read
        read += record_rows(source, options, term, number, rows, jobs, seen, result)
        url = next_page_url(page, source)
        if not url:
            return read
        if number == 1 and context is not None and options.my_chrome and options.pages_at_once > 1:
            rest = remaining_pages(page, source, url, limit)
            if rest is not None:
                pages, cut_short = rest
                read += crawl_pages_side_by_side(context, source, options, term, pages, jobs, seen, run_dir, result)
                if cut_short:
                    result["more_pages"] = True
                return read
        if number < limit:
            pause(options.delay)
    result["more_pages"] = True
    return read


def crawl_source(page, source, options, jobs, seen, run_dir, result, context=None):
    """Run the searches of one site, filling result as it goes."""
    terms = search_terms(source, options)
    for index, term in enumerate(terms):
        if index:
            pause(options.delay)
        if not crawl_search(page, source, options, term, jobs, seen, run_dir, result, context) and term:
            if result["status"] == "ok":
                result["no_jobs_for"].append(term)
        if result["status"] != "ok":
            return
    notes = []
    if result["no_jobs_for"]:
        notes.append("no matching jobs for: %s" % ", ".join(result["no_jobs_for"]))
    if (options.company or options.location or options.role) and not result["jobs"] and result["filtered_out"]:
        notes.append("%d jobs were read but none matched the filters" % result["filtered_out"])
    if result["more_pages"]:
        notes.append("stopped after %d pages; the site has more pages" % (options.max_pages or MAX_PAGES))
    result["message"] = "; ".join(notes)


# --my-chrome: drive the Google Chrome you already use, on macOS, through AppleScript. Chrome refuses
# outside control (Playwright's way in) of the everyday profile, but "Allow JavaScript from Apple
# Events" lets a script run JavaScript in a window, so your logins are there and the page sees a
# normal browser (navigator.webdriver is false). The tool opens its own windows, runs JavaScript only
# in those, closes them, and never quits Chrome.
CHROME_SCRIPTS = {
    "open": """tell application "Google Chrome"
	set w to make new window
	return id of w
end tell""",
    "navigate": """on run argv
	tell application "Google Chrome"
		set URL of active tab of window id ((item 1 of argv) as integer) to (item 2 of argv)
	end tell
end run""",
    "javascript": """on run argv
	tell application "Google Chrome"
		return execute active tab of window id ((item 1 of argv) as integer) javascript (item 2 of argv)
	end tell
end run""",
    "close": """on run argv
	tell application "Google Chrome"
		close window id ((item 1 of argv) as integer)
	end tell
end run""",
    "exists": """on run argv
	tell application "Google Chrome"
		return exists window id ((item 1 of argv) as integer)
	end tell
end run""",
    "open_at": """on run argv
	tell application "Google Chrome"
		set w to make new window
		set bounds of w to {(item 1 of argv) as integer, (item 2 of argv) as integer, (item 3 of argv) as integer, (item 4 of argv) as integer}
		return id of w
	end tell
end run""",
    "bounds": """on run argv
	tell application "Google Chrome"
		set bounds of window id ((item 1 of argv) as integer) to {(item 2 of argv) as integer, (item 3 of argv) as integer, (item 4 of argv) as integer, (item 5 of argv) as integer}
	end tell
end run""",
    "activate": """tell application "Google Chrome" to activate""",
    "window_ids": """tell application "Google Chrome" to return id of every window""",
}
CHROME_PROGRAM = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CHROME_BUSY = ("(-609)", "(-600)", "(-1712)")  # connection lost, app not answering yet, timed out: try again
# Calls that can bring Chrome to the front; in quiet mode the app that had the focus gets it back.
FOCUS_STEALERS = ("open", "open_at", "navigate", "open_window")
# Chrome also takes the focus by itself 1 to 3 seconds after a page starts loading, after the focus was given
# back (measured on 2026-11-27: a window, or a tab, loading a page). So for a few seconds after each such
# command the front app is looked at, and given back when Chrome has just taken it.
FOCUS_WATCH_SECONDS = 4
FOCUS_WATCH_POLL = 0.3


def front_app_path():
    """Where the app in front lives, as "/Applications/Microsoft Excel.app"; "" when it cannot be told."""
    try:
        front = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True, timeout=5).stdout.strip()
        info = subprocess.run(["lsappinfo", "info", "-only", "bundlepath", front], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return ""
    found = re.search(r'="([^"]+)"', info.stdout)
    return found.group(1) if found else ""


def return_focus(path):
    """Give the focus back to the app at path, unless that is Chrome itself."""
    if path and "Google Chrome" not in path:
        try:
            subprocess.run(["open", path], capture_output=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            pass


CHROME_GONE =("Can’t get window", "Can't get window", "Invalid index", "(-1728)", "(-1719)")


class ChromeError(Exception):
    """Chrome would not do what was asked, or its window is gone."""


class ChromeResponse:
    def __init__(self, status):
        self.status = status


class ChromeBridge:
    """Runs one small AppleScript against Chrome and returns what it printed.

    In quiet mode the tool's windows are parked with only a thin sliver on the screen, and the app
    that had the focus gets it back after a window opens or navigates. The windows share one record
    of who had the focus: two windows doing it at once would each see Chrome in front, because of the
    other, and give Chrome the focus back."""

    def __init__(self, quiet=False, profile="Default"):
        self.quiet = quiet
        self.profile = profile  # the Chrome profile folder the windows open in: "Default", "Profile 3"
        self.screen = None  # (width, height, top) of the usable screen, read from the first window
        self._opening = threading.Lock()  # one window opens at a time, so a new window's id is certain
        self._focus = threading.RLock()  # one window at a time takes the focus and gives it back
        self._forward = 0  # how many windows are forward for a person to click a check
        self._app_before = ""  # the app that had the focus before the first of them came forward
        self._watched_app = ""  # the app to give the focus back to; "" when nobody is watching
        self._watch_until = 0.0
        self._watching = False  # the thread that looks at the front app is running

    @contextlib.contextmanager
    def keeping_focus(self):
        """Around a command that can bring Chrome forward: the app that had the focus gets it back after,
        and again if Chrome takes it a moment later. Nothing is done when the person is in Chrome."""
        if not self.quiet:
            yield
            return
        with self._focus:
            keep = front_app_path()
            self._watch(keep)
            try:
                yield
            finally:
                return_focus(keep)

    def _watch(self, keep):
        with self._focus:
            if not keep or "Google Chrome" in keep:
                self._watched_app = ""  # the person is in Chrome, or nobody can be told where they are
                return
            self._watched_app = keep
            self._watch_until = time.monotonic() + FOCUS_WATCH_SECONDS
            if self._watching:
                return
            self._watching = True
        threading.Thread(target=self._watch_loop, daemon=True).start()

    def _watch_loop(self):
        in_chrome = False  # the focus was just given back
        while True:
            time.sleep(FOCUS_WATCH_POLL)
            in_chrome = self._watch_step(in_chrome)
            if in_chrome is None:
                return

    def _watch_step(self, in_chrome):
        """One look at the front app. Returns whether Chrome is in front, or None when watching is over.

        Chrome taking the focus is what is undone, once each time it happens: a person who then goes to
        Chrome on purpose is left alone as soon as a command sees them there."""
        with self._focus:
            if not self._watched_app or time.monotonic() > self._watch_until:
                self._watching = False
                return None
        front = front_app_path()
        chrome = "Google Chrome" in front
        with self._focus:
            if not self._watched_app:
                return chrome
            if not chrome:
                if front:
                    self._watched_app = front  # the person moved on to another app: that one gets it back
                return False
            if not in_chrome and not self._forward:
                return_focus(self._watched_app)
                return False
            return True

    def hold_focus(self):
        """A window is coming forward for a person: remember who had the focus, once for all such windows."""
        with self._focus:
            if not self._forward:
                self._app_before = front_app_path() if self.quiet else ""
            self._forward += 1

    def release_focus(self):
        """That window is back: when the last one is, the app that had the focus gets it again."""
        with self._focus:
            self._forward = max(0, self._forward - 1)
            if self._forward:
                return
            keep, self._app_before = self._app_before, ""
        return_focus(keep)

    def open_window(self):
        """Open a window in the chosen profile and return its id.

        AppleScript's own "make new window" opens in whichever profile Chrome used last, and the
        Apple Events setting is saved per profile, so it was off whenever another profile had been in
        use. Starting Chrome with --profile-directory opens the window in the profile asked for."""
        with self.keeping_focus(), self._opening:
            before = self._window_ids()
            try:
                # Chrome's own program, not `open -na`: it hands the request to the running Chrome and
                # exits, whereas `open -na` registers a second Chrome that AppleScript then sometimes
                # talked to while it was quitting ("Application isn't running", "Connection is invalid").
                subprocess.run(
                    [CHROME_PROGRAM, "--profile-directory=%s" % self.profile, "--new-window", "about:blank"],
                    capture_output=True, timeout=30)
            except (OSError, subprocess.SubprocessError) as error:
                raise ChromeError("could not start Google Chrome: %s" % error)
            for _ in range(60):  # up to 15 seconds for the new window to appear
                try:
                    new = [window for window in self._window_ids() if window not in before]
                except ChromeError:
                    new = []  # Chrome is busy opening it: look again
                if new:
                    return str(new[-1])
                time.sleep(0.25)
            raise ChromeError("Chrome opened no new window in the profile %r" % self.profile)

    def _window_ids(self):
        return [int(part) for part in re.findall(r"\d+", self._run("window_ids"))]

    def parked_bounds(self):
        """Where a quiet window sits: a normal-sized window with only a 32 pixel sliver on the screen, at the
        right edge. A tiny 200 by 120 window did not do: CareerViet showed no job cards in it."""
        if not (self.quiet and self.screen):
            return None
        width, height, top = self.screen
        return (width - 32, top + 40, width - 32 + 1300, top + 40 + min(700, height - 80))

    def showing_bounds(self):
        """A comfortable window, for the moment a person has to do something in it."""
        if not self.screen:
            return None
        width, height, top = self.screen
        return (100, top + 40, min(width - 100, 1300), top + min(height - 40, 760))

    def run(self, name, *args):
        if not (self.quiet and name in FOCUS_STEALERS):
            return self._run(name, *args)
        with self.keeping_focus():
            return self._run(name, *args)

    def _run(self, name, *args):
        for attempt in range(1, 4):
            try:
                done = subprocess.run(
                    ["osascript", "-", *[str(arg) for arg in args]], input=CHROME_SCRIPTS[name],
                    capture_output=True, text=True, timeout=90)
            except subprocess.TimeoutExpired:
                raise ChromeError("Chrome did not answer within 90 seconds")
            if not done.returncode:
                break
            problem = clean(done.stderr)
            if any(text in problem for text in CHROME_BUSY) and attempt < 3:
                time.sleep(0.7 * attempt)  # the connection to Chrome dropped for a moment: ask again
                continue
            if any(text in problem for text in CHROME_GONE):
                gone = ChromeError("Target page, context or browser has been closed")
                gone.raw = problem[:200]  # what AppleScript really said, logged only if the window is truly gone
                raise gone
            raise ChromeError(problem[:300] or "osascript failed")
        output = done.stdout[:-1] if done.stdout.endswith("\n") else done.stdout
        return "" if output == "missing value" else output


class ChromeLocator:
    def __init__(self, page, selector):
        self.page, self.selector = page, selector

    def count(self):
        # Playwright's :has-text("...") is not CSS: count the matches of the CSS part that contain the text.
        base, _, rest = self.selector.partition(':has-text("')
        if rest:
            text = rest.rsplit('")', 1)[0]
            code = "[...document.querySelectorAll(%s)].filter((e) => e.textContent.includes(%s)).length" % (
                json.dumps(base), json.dumps(text))
        else:
            code = "document.querySelectorAll(%s).length" % json.dumps(self.selector)
        return int(self.page.script(code) or 0)


class ChromePage:
    """The few things the crawler does with a page, done in a Chrome window."""

    def __init__(self, bridge, window_id):
        self.bridge, self.window_id = bridge, window_id
        self._forward = False  # this window is forward for a person to click a check

    def ask(self, name, *args):
        """Ask Chrome. "Can't get window" can be a hiccup just after a window opens, so only a window
        that really is gone counts as closed; otherwise the request is tried again."""
        for attempt in range(1, 4):
            try:
                return self.bridge.run(name, self.window_id, *args)
            except ChromeError as error:
                if not is_closed(error) or attempt == 3 or self.bridge.run("exists", self.window_id) != "true":
                    if getattr(error, "raw", ""):
                        log("[chrome] AppleScript said: %s" % error.raw)  # shows what really happened
                    raise
                time.sleep(0.5 * attempt)

    def script(self, code):
        return self.ask("javascript", code)

    @property
    def url(self):
        return self.script("location.href")

    def title(self):
        return self.script("document.title")

    def locator(self, selector):
        return ChromeLocator(self, selector)

    def evaluate(self, function):
        text = self.script("JSON.stringify((%s)())" % function)
        return json.loads(text) if text else None

    def settle(self, timeout=8000):
        """A new window is still loading Chrome's new tab page for a moment, and a page opened in that
        moment can be overwritten by it. Wait until the window has stopped loading."""
        deadline = time.monotonic() + timeout / 1000
        while time.monotonic() < deadline:
            if self.script("document.readyState") != "loading":
                return
            time.sleep(0.3)

    def goto(self, url, wait_until=None, timeout=60000):
        asked = urlparse(url).hostname or ""
        for attempt in range(1, 4):
            try:
                self.script("window.__crawlerLeft = true")  # marks the page being left; a new page has no mark
            except ChromeError as error:
                if is_closed(error):
                    raise
            self.ask("navigate", url)
            deadline = time.monotonic() + timeout / 1000
            timed_out = False
            while True:
                if time.monotonic() >= deadline:
                    timed_out = True
                    break
                time.sleep(0.4)
                try:
                    state = self.script("window.__crawlerLeft ? 'old' : document.readyState")
                except ChromeError as error:
                    if is_closed(error):
                        raise
                    continue  # the new page is not ready to run JavaScript yet
                if state in ("interactive", "complete"):
                    break
            if timed_out:
                if attempt < 2:
                    continue  # ITviec once stopped at page 22 this way: send the address once more
                raise ChromeError("the page did not load within %d seconds" % (timeout // 1000))
            landed = urlparse(self.url)
            if landed.scheme in ("chrome", "chrome-untrusted", "about") and attempt < 3:
                time.sleep(1.0)  # still on Chrome's own page: the window overwrote the address, so send it again
                continue
            status = self.script("String((performance.getEntriesByType('navigation')[0] || {}).responseStatus || '')")
            return ChromeResponse(int(status) if status.isdigit() else None)

    def fill(self, selector, text):
        self.script(
            "(() => { const box = document.querySelector(%s); box.focus(); box.value = %s;"
            " box.dispatchEvent(new Event('input', { bubbles: true })); })()" % (json.dumps(selector), json.dumps(text)))

    def press(self, selector, key):
        self.script(
            "(() => { const box = document.querySelector(%s); for (const type of ['keydown', 'keypress', 'keyup'])"
            " box.dispatchEvent(new KeyboardEvent(type, { key: %s, code: %s, keyCode: 13, which: 13, bubbles: true })); })()"
            % (json.dumps(selector), json.dumps(key), json.dumps(key)))

    def wait_for_url(self, matches_new_url, timeout=30000):
        deadline = time.monotonic() + timeout / 1000
        while time.monotonic() < deadline:
            time.sleep(0.4)
            if matches_new_url(self.url):
                return
        raise ChromeError("the address did not change within %d seconds" % (timeout // 1000))

    def screenshot(self, path):
        """No picture is taken of a window: keep what the page said, as text, as evidence."""
        text = self.script("location.href + '\\n' + document.title + '\\n\\n' + (document.body ? document.body.innerText : '').slice(0, 3000)")
        Path(path).with_suffix(".txt").write_text(text, encoding="utf-8")

    def close(self):
        self.bridge.run("close", self.window_id)

    def show(self):
        """Bring the window forward at a usable size, for a human check that a person has to click."""
        if not self._forward:
            getattr(self.bridge, "hold_focus", lambda: None)()
            self._forward = True
        try:
            bounds = getattr(self.bridge, "showing_bounds", lambda: None)()
            if bounds:
                self.ask("bounds", *bounds)
            self.bridge.run("activate")
        except ChromeError:
            self.hide()
            raise

    def hide(self):
        """Put a quiet window back at the edge of the screen, and the focus back where it was."""
        try:
            bounds = getattr(self.bridge, "parked_bounds", lambda: None)()
            if bounds:
                self.ask("bounds", *bounds)
        finally:
            if self._forward:
                self._forward = False
                getattr(self.bridge, "release_focus", lambda: None)()


class ChromeContext:
    """Stands in for a Playwright browser context. It never quits Chrome."""

    def __init__(self, bridge):
        self.bridge = bridge

    def new_page(self):
        parked = getattr(self.bridge, "parked_bounds", lambda: None)()
        if hasattr(self.bridge, "open_window"):  # a window in the chosen profile, moved to the edge afterwards
            window = self.bridge.open_window()
            if parked:
                self.bridge.run("bounds", window, *parked)
        else:
            window = self.bridge.run("open_at", *parked) if parked else self.bridge.run("open")
        page = ChromePage(self.bridge, int(window))
        try:
            page.settle()
        except ChromeError:
            try:
                page.close()  # a window that cannot be used is not left open
            except ChromeError:
                pass
            raise
        return page

    def close(self):
        pass


def chrome_installed():
    return os.path.exists(CHROME_PROGRAM)


def chrome_problem():
    """Why Chrome cannot be used right now, or "" when it can."""
    if not chrome_installed():
        return "could not find Google Chrome at %s" % CHROME_PROGRAM
    if subprocess.run(["pgrep", "-x", "Google Chrome"], capture_output=True).returncode:
        return "Google Chrome is not open. Open it (any profile), then run this again."
    return ""


NO_PROFILE_MESSAGE = (
    "Turn on \"Allow JavaScript from Apple Events\" in Chrome first: no Chrome profile has it on. Open Chrome in the "
    "profile whose logins you want to use, then choose View -> Developer -> Allow JavaScript from Apple Events "
    "(it gets a tick). Chrome saves the setting within a few seconds. Then run this again. "
    "(--own-browser reads the pages in a browser the tool starts itself, which Cloudflare often blocks.)")


def chrome_profiles_with_apple_events(root=None):
    """The Chrome profile folders that have "Allow JavaScript from Apple Events" on, the one you used last first.

    Chrome saves the setting per profile, in that profile's Preferences file as
    browser.allow_javascript_apple_events; that one value is the only thing read from it. Chrome's Local State
    says which profile was used last and in what order the profiles are listed."""
    root = Path(root) if root else Path.home() / "Library" / "Application Support" / "Google" / "Chrome"
    try:
        state = json.loads((root / "Local State").read_text(encoding="utf-8")).get("profile", {})
    except (OSError, ValueError, AttributeError):
        state = {}
    if not isinstance(state, dict):
        state = {}
    enabled = []
    for preferences in sorted(root.glob("*/Preferences")):
        folder = preferences.parent.name
        if folder in ("System Profile", "Guest Profile"):
            continue
        try:
            browser = json.loads(preferences.read_text(encoding="utf-8")).get("browser")
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(browser, dict) and browser.get("allow_javascript_apple_events") is True:
            enabled.append(folder)
    rank = {}
    order = [state.get("last_used")] + list(state.get("profiles_order") or [])
    for index, name in enumerate(order):
        if isinstance(name, str):
            rank.setdefault(name, index)
    return sorted(enabled, key=lambda name: (rank.get(name, len(rank)), name))


def choose_browser(options):
    """Decide how the pages are read before anything opens.

    On macOS with Chrome installed it is your own Chrome, and the profile is the one that has "Allow JavaScript
    from Apple Events" on, so neither --my-chrome nor --chrome-profile has to be given. --own-browser and
    --headless keep the browser the tool starts itself, and so does a computer that is not a Mac."""
    if not options.my_chrome:
        if options.own_browser or options.headless or sys.platform != "darwin" or not chrome_installed():
            return
        options.my_chrome = True
    if sys.platform != "darwin" or options.chrome_profile:
        return  # --my-chrome elsewhere is refused later, and a profile that was named is used as named
    found = chrome_profiles_with_apple_events()
    if not found:
        sys.exit(NO_PROFILE_MESSAGE)
    options.chrome_profile = found[0]
    log("[chrome] using your Chrome profile %r, which has \"Allow JavaScript from Apple Events\" on%s" % (
        found[0], "; so do %s, --chrome-profile picks another" % ", ".join(found[1:]) if found[1:] else ""))


def connect_real_chrome(quiet=True, profile="Default"):
    """Check that Chrome can be driven, and say how to fix it when it cannot."""
    global PlaywrightError
    if sys.platform != "darwin":
        sys.exit("--my-chrome drives Google Chrome through AppleScript, which only macOS has")
    PlaywrightError = ChromeError
    problem = chrome_problem()
    if problem:
        sys.exit(problem)
    bridge = ChromeBridge(quiet, profile)
    context = ChromeContext(bridge)
    probe = None
    try:
        probe = context.new_page()
        if probe.evaluate("() => 1 + 1") != 2:
            sys.exit("Chrome answered, but not with the result of a test sum")
        try:  # the size of the usable screen, so that quiet windows can be parked at its edge
            width, height, top = (int(part) for part in probe.script(
                "screen.availWidth + ',' + screen.availHeight + ',' + screen.availTop").split(","))
            bridge.screen = (width, height, top)
        except (ValueError, ChromeError):
            pass  # windows then open at their usual size
    except ChromeError as error:
        text = str(error)
        if "turned off" in text:
            sys.exit("The windows opened in the Chrome profile %r, and it has \"Allow JavaScript from Apple Events\" "
                     "turned off. The setting belongs to one profile: in a Chrome window of that profile, open the View "
                     "menu, then Developer, and turn it on. To use another profile, run this again with "
                     "--chrome-profile=\"Profile 3\" (the folder name shown at chrome://version as Profile Path)." % profile)
        if "-1743" in text or "not authorized" in text.lower():
            sys.exit("Allow your terminal to control Google Chrome: System Settings, Privacy & Security, Automation. "
                     "Then run this again.")
        sys.exit("could not control Google Chrome: %s" % text)
    finally:
        if probe is not None:
            try:
                probe.close()
            except ChromeError:
                pass
    return context


def import_playwright(cache_dir):
    """Import Playwright, installing it with pip into the cache folder on the first run."""
    global PlaywrightError
    site = cache_dir / "site"
    sys.path.insert(0, str(site))
    try:
        from playwright.sync_api import Error, sync_playwright
    except ImportError:
        log("First run: installing Playwright into %s (needs a network connection)." % site)
        site.mkdir(parents=True, exist_ok=True)
        command = [
            sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
            "--target", str(site), "playwright",
        ]
        if subprocess.run(command).returncode != 0:
            sys.exit("could not install Playwright with pip; install it yourself with "
                     "`python3 -m pip install --target '%s' playwright`" % site)
        import importlib
        importlib.invalidate_caches()
        from playwright.sync_api import Error, sync_playwright
    PlaywrightError = Error
    return sync_playwright


def launch(playwright, cache_dir, headless):
    """Open Chrome with the tool's own profile; download Chromium only if Chrome is missing."""
    profile = cache_dir / "profile"
    profile.mkdir(parents=True, exist_ok=True)
    try:
        return playwright.chromium.launch_persistent_context(
            str(profile), channel="chrome", headless=headless
        )
    except PlaywrightError as error:
        message = str(error).lower()
        if not any(text in message for text in ("doesn't exist", "not found", "not installed")):
            raise
    log("Google Chrome was not found; downloading Chromium for Playwright once (about 150 MB).")
    environment = dict(os.environ, PYTHONPATH=str(cache_dir / "site"))
    command = [sys.executable, "-m", "playwright", "install", "chromium"]
    if subprocess.run(command, env=environment).returncode != 0:
        sys.exit("could not download Chromium; install Google Chrome and run this again")
    return playwright.chromium.launch_persistent_context(str(profile), headless=headless)


def bounded(low, high, kind):
    def parse(text):
        try:
            value = kind(text)
        except ValueError:
            raise argparse.ArgumentTypeError("%r is not a number" % text)
        if not low <= value <= high:
            raise argparse.ArgumentTypeError("must be between %s and %s" % (low, high))
        return value
    return parse


def keyword_argument(text):
    text = clean(text)
    if len(text) > 100 or any(ord(char) < 32 for char in text):
        raise argparse.ArgumentTypeError("a keyword is at most 100 characters of plain text")
    return text


def terms_argument(text):
    """Comma-separated words to match, such as "Ha Noi, Ho Chi Minh"."""
    terms = [clean(term) for term in text.split(",")]
    terms = [term for term in terms if term]
    if not terms or len(terms) > 10 or any(len(term) > 100 or any(ord(char) < 32 for char in term) for term in terms):
        raise argparse.ArgumentTypeError("give 1 to 10 comma-separated words of plain text")
    return terms


def sources_argument(text):
    names = []
    for name in text.lower().split(","):
        name = name.strip()
        if name not in SOURCES:
            raise argparse.ArgumentTypeError(
                "unknown site %r; choose from %s" % (name, ", ".join(SOURCES)))
        if name not in names:
            names.append(name)
    return names


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        prog="job-crawler",
        description="Collect IT job listings from job boards and company career pages into a spreadsheet and a CSV file.",
    )
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR,
                        help="where the dated run folder goes (default %(default)s)")
    parser.add_argument("--sources", type=sources_argument, default=list(SOURCES),
                        help="comma-separated sites: %s (default: all)" % ", ".join(SOURCES))
    parser.add_argument("--keyword", type=keyword_argument, default="",
                        help="search for this word, such as python, instead of the whole list")
    parser.add_argument("--company", type=terms_argument, default=[],
                        help="keep only jobs whose company contains this text, as the site writes it; "
                             "separate several with commas")
    parser.add_argument("--role", type=terms_argument, default=[],
                        help="keep only jobs whose title has this role, such as 'Software Engineer, Product Owner'; "
                             "Front-end, Frontend and Front end are the same")
    parser.add_argument("--location", type=terms_argument, default=[],
                        help="keep only jobs whose location contains this text, such as 'Ha Noi'; "
                             "separate several with commas")
    parser.add_argument("--date", type=bounded(0, 3650, int), default=30,
                        help="keep only jobs posted or edited in the last this many days, such as 60 or 90; "
                             "0 keeps every date. A job whose page shows no date is kept (default %(default)s)")
    parser.add_argument("--max-pages", type=bounded(0, MAX_PAGES, int), default=0,
                        help="list pages to read per site; 0 reads every page, up to %d (default %%(default)s)"
                        % MAX_PAGES)
    parser.add_argument("--delay", type=bounded(1, 60, float), default=4.0,
                        help="seconds to wait between pages, plus up to half again (default %(default)s)")
    parser.add_argument("--challenge-wait", type=bounded(10, 1800, int), default=300,
                        help="seconds to wait for you to finish a human check (default %(default)s)")
    parser.add_argument("--my-chrome", action="store_true",
                        help="macOS: read the pages in the Google Chrome you already use, with your logins, in "
                             "windows of its own, instead of in a browser the tool starts. This is already what "
                             "happens on a Mac with Chrome, so the flag is only needed to insist on it. Needs View > "
                             "Developer > Allow JavaScript from Apple Events turned on in a Chrome profile")
    parser.add_argument("--own-browser", action="store_true",
                        help="read the pages in a browser the tool starts itself (Playwright) even on a Mac with "
                             "Chrome. Cloudflare often blocks that browser")
    parser.add_argument("--sites-at-once", type=bounded(1, 8, int), default=3,
                        help="with --my-chrome: sites read at the same time, each in a window of its own; sites are "
                             "different servers, so this adds no load to any one of them (default %(default)s, "
                             "1 reads one site after another)")
    parser.add_argument("--pages-at-once", type=bounded(1, 10, int), default=5,
                        help="with --my-chrome: pages of one site read at the same time, for a site that has the page "
                             "number in its address (default %(default)s, 1 reads one page after another). More is "
                             "faster but more likely to bring a human check or a block")
    parser.add_argument("--chrome-profile", default="",
                        help="with your own Chrome: the profile whose logins to use, by its folder name: Default, "
                             "Profile 3 and so on (see Profile Path at chrome://version). By default it is found: "
                             "the profile that has View > Developer > Allow JavaScript from Apple Events turned "
                             "on, the one you used last if several do. The windows open in this profile whichever "
                             "one you used last")
    parser.add_argument("--show-windows", action="store_true",
                        help="with --my-chrome: open the windows at their usual size, in front. By default they are "
                             "small, parked at the right edge of the screen, and the app you were using keeps "
                             "the focus; a window is brought forward only when a human check needs a click")
    parser.add_argument("--headless", action="store_true",
                        help="hide the browser window; a human check then ends that site")
    parser.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR,
                        help="Playwright and the browser profile (default %(default)s)")
    options = parser.parse_args(argv)
    if options.my_chrome and options.own_browser:
        parser.error("--my-chrome and --own-browser cannot be used together")
    options.output_dir = Path(os.path.expanduser(options.output_dir))
    options.cache_dir = Path(os.path.expanduser(options.cache_dir))
    return options


def write_run(run_dir, jobs, report):
    run_dir.mkdir(parents=True, exist_ok=True)
    if jobs:  # a header-only sheet would look like a result
        write_xlsx(run_dir / "jobs.xlsx", jobs)
        write_csv(run_dir / "jobs.csv", jobs)
    (run_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def print_summary(run_dir, results, total):
    print("job-crawler finished: %d jobs" % total)
    for name, result in results.items():
        line = "  %-7s %-11s %2d pages %5d jobs" % (name, result["status"], result["pages"], result["jobs"])
        print(line + ("  " + result["message"] if result["message"] else ""))
    if total:
        print("Sheet:  %s" % (run_dir / "jobs.xlsx"))
        print("CSV:    %s" % (run_dir / "jobs.csv"))
    else:
        print("No jobs were collected, so there is no sheet or CSV. The report says why.")
    print("Report: %s" % (run_dir / "report.json"))


def collect_side_by_side(context, options, jobs, seen, results, run_dir):
    """Read several sites at the same time, each in a window of its own, with --my-chrome."""
    for name in options.sources:
        results[name] = new_result()
    finished = set()

    def read_site(item):
        index, name = item
        time.sleep(2.0 * (index % options.sites_at_once))  # the first windows open a moment apart
        page = context.new_page()
        try:
            crawl_source(page, SOURCES[name], options, jobs, seen, run_dir, results[name], context)
        except PlaywrightError as error:
            results[name]["status"] = "error"
            results[name]["message"] = CLOSED_MESSAGE if is_closed(error) else first_line(error)
        finally:
            try:
                page.close()
            except PlaywrightError:
                pass
            finished.add(name)

    pool = ThreadPoolExecutor(max_workers=options.sites_at_once)
    try:
        list(pool.map(read_site, enumerate(options.sources)))
    except KeyboardInterrupt:
        log("Interrupted: saving what was collected.")
        pool.shutdown(wait=False, cancel_futures=True)
        for name in options.sources:
            if name not in finished:
                results[name]["status"] = "interrupted"
    finally:
        pool.shutdown(wait=False)
        context.close()


def collect(context, options, jobs, seen, results, run_dir):
    """Read every wanted site into jobs, each in a fresh window, and fill results as it goes."""
    if options.my_chrome and options.sites_at_once > 1 and len(options.sources) > 1:
        return collect_side_by_side(context, options, jobs, seen, results, run_dir)
    current = None
    try:
        for index, name in enumerate(options.sources):
            current = name
            results[name] = new_result()
            if index:
                pause(options.delay)
            # Each site gets a fresh tab. Reusing the browser's first tab was sent straight back
            # to the previous site (Lecle) on the way to the next one, in 3 of 4 runs.
            page = context.new_page()
            try:
                crawl_source(page, SOURCES[name], options, jobs, seen, run_dir, results[name], context)
            finally:
                try:
                    page.close()
                except PlaywrightError:
                    pass
            if results[name]["message"] == CLOSED_MESSAGE:
                for later in options.sources[index + 1:]:
                    results[later] = dict(new_result(), status="skipped", message=CLOSED_MESSAGE)
                break
    except KeyboardInterrupt:
        log("Interrupted: saving what was collected.")
        if current:
            results[current]["status"] = "interrupted"
    finally:
        context.close()


def main(argv=None):
    options = parse_args(argv)
    if options.output_dir.exists() and not options.output_dir.is_dir():
        sys.exit("--output-dir is not a folder: %s" % options.output_dir)
    choose_browser(options)
    started = datetime.now(timezone.utc)
    run_dir = options.output_dir / datetime.now().strftime("%Y-%m-%d-%H%M%S")
    jobs, seen, results = [], set(), {}
    if options.my_chrome:
        chrome = connect_real_chrome(quiet=not options.show_windows, profile=options.chrome_profile)
        collect(chrome, options, jobs, seen, results, run_dir)
    else:
        sync_playwright = import_playwright(options.cache_dir)
        with sync_playwright() as playwright:
            collect(launch(playwright, options.cache_dir, options.headless), options, jobs, seen, results, run_dir)

    jobs = sort_jobs(jobs)
    report = {
        "started_at": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "finished_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "keyword": options.keyword,
        "company": options.company,
        "location": options.location,
        "role": options.role,
        "date_days": options.date,
        "jobs_without_a_date": sum(1 for job in jobs if job.get("posted_on") is None),
        "headless": options.headless,
        "my_chrome": options.my_chrome,
        "chrome_profile": options.chrome_profile if options.my_chrome else "",
        "sites_at_once": options.sites_at_once if options.my_chrome else 1,
        "pages_at_once": options.pages_at_once if options.my_chrome else 1,
        "max_pages": options.max_pages,
        "total_jobs": len(jobs),
        "role_groups": {group: sum(1 for job in jobs if job["role"] == group) for group in ROLE_GROUPS if any(job["role"] == group for job in jobs)},
        "sources": results,
    }
    write_run(run_dir, jobs, report)
    print_summary(run_dir, results, len(jobs))
    return 0 if all(result["status"] == "ok" for result in results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
