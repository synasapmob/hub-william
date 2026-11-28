# JOB CRAWLER

Collect IT job listings from the job boards ITviec, TopCV and CareerViet and from
the career pages of WorldQuant, Topicus Vietnam, Symbotic, Lecle Vietnam, Luce
and Axon into a spreadsheet on your computer. It opens a real Chrome window,
reads the job cards each page renders and writes `jobs.xlsx`, `jobs.csv` and a
`report.json` to a dated folder, with the jobs of the companies or places you ask
for. The pages are read from the sites and the files stay on your computer;
nothing is uploaded.

## Requirements

Python 3.9 or newer on macOS or Linux, Google Chrome, and a network connection.
It was tested on macOS with Python 3.9 and Chrome only.

**On a Mac with Chrome (the default, and the mode that gets past Cloudflare)** you
need macOS, Google Chrome, Python 3.9 or newer, and one setting in Chrome, View ->
Developer -> **Allow JavaScript from Apple Events** (see Using your own Chrome).
The tool finds the Chrome profile that has the setting on by itself, so there is
no flag to add. If no profile has it on, the tool stops before opening anything
and says where to turn it on. Nothing is installed: no Playwright, no pip.

**Elsewhere, or with `--own-browser` or `--headless`,** the first run installs
[Playwright](https://pypi.org/project/playwright/) with pip into
`~/.cache/hub-william/job-crawler` (`--cache-dir` changes it). If Chrome is not
installed it downloads Playwright's Chromium (about 150 MB) instead; that path has
not been tested. Cloudflare blocked this browser on TopCV and asked ITviec for a
check in the tests of 2026-11-27, so on a Mac leave your own Chrome on.

## Run

Replace `~/Documents/jobs` with the folder where you want the results:

```sh
curl -fsSL https://hub-william.site/catalog/contributors/synasapmob/tools/job-crawler/job-crawler.py | python3 - --output-dir=~/Documents/jobs
```

`curl` has its own `--output` option, so the tool's options go after
`python3 -`. Run a downloaded copy with `python3 job-crawler.py --output-dir=...`.

On the Tools page of Hub William you do not have to write the options: pick the
location (HN, HCM, DA NANG, REMOTE), the role, the source and how far back with
tags, name the folder, and copy the command it builds.

## Options

| Option                | Default            | What it does                                                    |
| --------------------- | ------------------ | --------------------------------------------------------------- |
| `--output-dir`        | `~/Documents/jobs` | Where the dated run folder is created                           |
| `--sources`           | all                | Comma-separated sites: `itviec`, `topcv`, `careerviet`, `worldquant`, `topicus`, `symbotic`, `lecle`, `luce`, `axon` |
| `--keyword`           | none               | Search a job board for a word such as `python`; on a company page, keep titles and tags that contain it |
| `--role`              | none               | Keep only jobs whose title has one of these roles (see Filters)  |
| `--date`              | `30`               | Keep only jobs posted or edited in the last this many days, such as `60` or `90`; `0` keeps every date (see Filters) |
| `--company`           | none               | Keep only jobs of this company, such as `MB Bank` (see Filters) |
| `--location`          | none               | Keep only jobs in this place, such as `Ha Noi` (see Filters)    |
| `--max-pages`         | `0` (every page)   | Stop after this many list pages per site; at most 200 either way |
| `--delay`             | `4`                | Seconds between pages, plus up to half again, 1 to 60           |
| `--challenge-wait`    | `300`              | Seconds to wait for you to finish a human check, 10 to 1800     |
| `--my-chrome`         | on for a Mac with Chrome | macOS: read the pages in your own Chrome, with your logins (see Using your own Chrome); only needed to insist on it |
| `--own-browser`       | off                | Read the pages in a browser the tool starts itself (Playwright) even on a Mac with Chrome; Cloudflare often blocks it |
| `--chrome-profile`    | found              | The Chrome profile whose logins to use, by folder name (`Default`, `Profile 3`). Found by itself: the profile with "Allow JavaScript from Apple Events" on, the last one you used if several |
| `--show-windows`      | off                | With `--my-chrome`: open windows at their usual size, in front (default: small, at the screen edge) |
| `--sites-at-once`     | `3`                | With `--my-chrome`: sites read at the same time (1 to 8)        |
| `--pages-at-once`     | `5`                | With `--my-chrome`: pages of one site read at the same time (1 to 10) |
| `--headless`          | off                | Hide the window; a human check then ends that site              |
| `--cache-dir`         | see above          | Playwright and the browser profile                              |

With no options it reads the jobs of every company: ITviec's whole IT jobs
list, TopCV's whole "Công nghệ Thông tin" category (which also lists some jobs
that are not IT) and CareerViet's "CNTT - Phần mềm" category, following the
next page until there is none, and keeps the ones from the last 30 days. On
2026-11-27 the lists held about 550 jobs on ITviec, 2,289 on TopCV and 441 on
CareerViet, so a full run takes a few minutes because of the pause between pages.
The filters below are optional ways to narrow it down; `--date=0` keeps jobs of
every date.

## Company career pages

Each is one list on one page, read in full. None names the company on every card
or can be searched, so the tool says the company itself and `--keyword` only
filters the titles it reads. Counts are from 2026-11-27.

| Source       | Page                                  | Jobs | What to know                                                                                              |
| ------------ | ------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------- |
| `worldquant` | `worldquant.com/career-listing`       | 78   | 13 are in "Hanoi or Ho Chi Minh City, Vietnam". Every job has its own link.                              |
| `topicus`    | `topicus.vn/careers`                  | 6    | All in Ho Chi Minh. Cards have a "View Details" button, not a link, so every title opens the careers page. |
| `symbotic`   | `symbotic.com/careers/jobs`           | 138  | 12 are in "VNM Ho Chi Minh"; 26 are "Remote & Travel" in the USA, Mexico or Canada. Own link per job.    |
| `lecle`      | `lecle.vn/careers`                    | 10   | The page gives no place per job; "Ho Chi Minh" is its only Vietnam office, so that is the place used. No link per job. |
| `luce`       | `luce.sg/jobs`                        | 17   | 3 are in Vietnam, but the page gives only the country, not the city. Own link per job; has a salary.     |
| `axon`       | `axon.com/careers/all`                | 458  | Only Axon's own "Work in Vietnam" list is read (Ho Chi Minh City, Vietnam and Vietnam-Remote), because the full list has another pager. It had 0 results. |

VinSmart Future has no career page of its own that the tool knows: its jobs are
listed on ITviec (`itviec.com/companies/vinsmart-future`), so `--company="VinSmart
Future"` finds them there, when ITviec lets the tool in.

## Filters

`--company` and `--location` keep a job only when its company or location
contains the text. Case and accents are ignored (`ha noi` matches "Hà Nội"), and
a comma-separated list means any of them (`--location="Ha Noi, Ho Chi Minh"`).
With both, a job must match both. Write the text as the site writes it: ITviec
says "Ha Noi" and "MB Bank", TopCV says "Hà Nội" and "Ngân hàng TMCP Quân Đội",
so `--company="MB Bank"` finds MB Bank on ITviec only.

For Ho Chi Minh City and remote work, use `--location="Ho Chi Minh City, Remote"`:

- "Ho Chi Minh City", "Ho Chi Minh", "HCM", "HCMC" and "Saigon" all mean the same
  place, so one spelling finds "Ho Chi Minh" (ITviec), "Hồ Chí Minh (mới)" (TopCV),
  "VNM Ho Chi Minh" (Symbotic) and "Hanoi or Ho Chi Minh City, Vietnam"
  (WorldQuant). A job listed in several cities counts if one of them is Ho Chi
  Minh City.
- "Remote" is looked for in the job's location and in its work model, because
  ITviec shows remote work as a work model. It also matches any place that says
  remote, such as Symbotic's "USA Remote & Travel", which is remote work in the
  USA. The tool cannot tell where a remote job may be worked from. TopCV and
  CareerViet do not mark remote jobs on their lists, so none are found there.
- A place written only as a country ("Vietnam", on Luce) does not match "Ho Chi
  Minh City". Add `Vietnam` to the list to include those jobs.

The sheet writes every city in one spelling, so that the filter list of the
`location` column has one entry for it and not one per way a site writes it:

- Ho Chi Minh City is `HCM` and Hanoi is `HN`, without "City", "Capital Region",
  "(mới)" or a trailing "Vietnam". Every other Vietnamese province is written
  without accents (`Da Nang`, `Can Tho`, `Dong Nai`), so TopCV's "Đà Nẵng (mới)"
  and ITviec's "Da Nang" are one entry.
- Several places are always separated by a comma, never a semicolon, and always in
  the same order: `HN`, `HCM`, `Da Nang`, then the others from A to Z. "Ha Noi -
  Ho Chi Minh" and "Ho Chi Minh - Ha Noi" both read `HN, HCM`.
- What only says there are more places ("& 2 nơi khác", "Others"), the word
  "Vietnam", and the parts of a city ("Quận 1", "Q3", "District 7", "Thành phố Thủ
  Đức") are left out, so Ho Chi Minh City with a district is still `HCM`.
- A text with no Vietnamese place in it ("USA Remote & Travel", "Singapore", a bare
  "Vietnam") stays as the site wrote it.
- A job in several places is one value, such as `HN, HCM`, so the filter list shows
  that combination. Excel's filter list has a search box: type `HN` and it lists
  every value with `HN` in it, then choose all of them to see every Hanoi job.

The filters read the site's own text, not the short form, so `Ho Chi Minh City`,
`HCM` and `Saigon` all find the same jobs, and so do `Hanoi`, `Ha Noi` and `HN`.

- **ITviec** and **CareerViet** search each `--company` on its own, one search per
  name, so a list such as `--company="Google, Meta, VinSmart Future"` runs three
  searches on each site. On ITviec, searching an exact company name opens that
  company's page, which lists all of its jobs in one go (checked on 2026-11-27: MB
  Bank, 23 jobs, all in Ha Noi); its cards have no `posted` or `work_model`
  because that page does not show them. CareerViet's keyword search matches
  company names (checked on 2026-11-27 with Vietcombank), and it also returns jobs
  that only mention the word, which the filter then drops.
- **TopCV** cannot be searched by company: its search box matches job titles, and
  "MB Bank" found no jobs there on 2026-11-27. So on TopCV both filters only apply
  to the pages that are read, which is all of them unless you set `--max-pages`.
- A company a site has no matching jobs for is listed in `report.json` under
  `no_jobs_for` and in its message. That is not a failure, and the other
  companies are still read.
- `report.json` also counts the jobs a filter removed (`filtered_out`) and says so
  when it removed everything.

`--role` keeps a job only when its **title** has one of the roles, for example
`--role="Software Engineer, Fullstack, Front-end, Back-end, Product Owner, Product
Manager, Solution Engineer, Mobile"`. Whole words are matched and spellings count
as the same: Front-end, Frontend and Front end; Full-stack, Fullstack and Full
Stack; Solution Engineer also finds Solutions Engineer; Software Engineer also
finds Software Developer. Some limits:

- The title is read, and so is the job's group (see Role, filtering and sorting in
  the sheet). A server stack word next to Developer or Engineer (.NET, C#, Java,
  PHP, Python, Golang, Node.js, Ruby, Laravel, Spring, Django) makes the job
  Backend, so `--role=Back-end` finds "Senior .NET Developer" and "Java Engineer".
  A plain "Developer" with no such word ("Quantitative Developer") and a title
  about data, testing or operations ("Data Engineer (Python)", "QA Engineer
  (Java)") are not. "Software Engineering Manager" is also left out.
- "Mobile" means a mobile developer: a mobile word (Mobile, Android, iOS,
  Flutter, React Native) next to Developer, Engineer or Programmer. Titles that
  only mention mobile, such as "Digital Marketing (Mobile App)", "UI/UX Designer
  – Mobile app" or "Manager, Mobile Robotics Controls", are left out.
- When `--role`, `--company` and `--location` are all given, a job must pass all
  three.

`--date=30` keeps a job only when it was posted, or last edited, in the last 30
days. It is the one filter that is on without being asked: with no `--date` it is
30. `--date=60` or `--date=90` reach further back (any whole number up to 3650),
and `--date=0` keeps every date. Some limits:

- It reads the date the sheet shows in `posted`, which is the last date: a job
  created 50 days ago and edited 5 days ago counts as 5 days old. The limit is
  inclusive (with `--date=30`, a job from exactly 30 days ago stays).
- ITviec and TopCV say "3 days ago", so their date is counted back from the day
  of the run and is approximate; a month counts as 30 days. CareerViet and Topicus
  give a date.
- A job whose page shows no date is kept, because nothing says it is old. On
  2026-11-27 these were all the jobs on the WorldQuant, Symbotic and Lecle career
  pages (18 jobs); every job on ITviec, TopCV and CareerViet had a date.
  `report.json` has `jobs_without_a_date` and `date_days`.
- The pages are still all read, because the lists are not sorted by date; the
  filter only drops the old jobs from the result. They count in `filtered_out`.

## What you get

Each run creates `<output-dir>/YYYY-MM-DD-HHMMSS/` with:

- `jobs.xlsx`: the sheet to open. Click a job's title to open the job on its site;
  there is no separate link column. The header row is frozen and has filter
  buttons, so you can also filter by role, company or location inside the sheet,
  and sort salary, experience and posted from the same buttons (see Role,
  filtering and sorting in the sheet).
- `jobs.csv`: the same jobs as plain text, with a `url` column because a CSV
  cannot hold a link behind a title. UTF-8 with a byte order mark, so Excel and
  Google Sheets show Vietnamese correctly. One row per job, repeats removed by
  the job's link.
- `report.json`: for each site, a status (`ok`, `challenge`, `blocked`,
  `not_found`, `empty`, `unreadable`, `error`, `skipped` or `interrupted`), the
  pages and jobs read, repeats dropped, jobs filtered out, whether the site has
  more pages than the limit, and a message.
- `screenshots/`: a picture of the page whenever a site did not finish, as
  evidence of what it showed.

When a run collects no jobs, it writes only `report.json` (and the screenshots)
and prints "No jobs were collected", so there is no empty sheet to mistake for a
result.

The columns are `source` (the site the job came from: ITviec, TopCV or
CareerViet), `role` (the group of the title: Backend, Fullstack and so on),
`title`, `company`, `location`, `salary`, `experience`, `work_model`, `posted` and
`url` (CSV only). The skills or categories a card shows (`tags`) and
the time the tool read the page are not written. On a job board `source` is the
board; on a career page it is the company, so a run that reads only career pages
leaves `source` out, because it would repeat `company`. In the sheet, the filter
button on `source` shows one site at a time. A site that does not show a field
leaves it empty:

- ITviec shows no salary to a visitor who is not signed in ("Sign in to view
  salary"), so `salary` is empty for ITviec in the tool's own browser, which never
  signs in. With `--my-chrome` the page is the one your signed-in Chrome gets, so
  the salary shows when the employer gives one (checked on 2026-11-27: 24 of 98
  jobs had an amount). ITviec's "You'll love it" means the employer keeps it
  private, and the cell is left empty.
- TopCV shows no work model on its list, so `work_model` is empty for TopCV and
  CareerViet, and `experience` is empty for ITviec and CareerViet.
- `posted` is one date in one format: `Created at 30-10-2026`, or `Edited at
  30-10-2026` when the page says the job was updated (CareerViet's "Cập nhật"),
  always the latest date the page shows. A page that gives an age ("Posted 3 days
  ago" on ITviec, "Đăng 1 tuần trước" on TopCV) is turned into a date counted
  back from the day of the run, so it is approximate (a month counts as 30
  days). A date the page gives, such as Topicus's "Nov 25, 2026", is used as it
  is, as Created. The pages of WorldQuant, Symbotic, Lecle, Luce and Axon show
  no date, so `posted` is empty for them.
- `experience` is shown as `4-5 years`, `4 years`, `5+ years`, `Under 1 year` or
  `Entry-level`: TopCV's "2 năm", "Trên 5 năm", "Dưới 1 năm" and "Không yêu cầu"
  and Topicus's "4-5 years" all come out in that form. Text that is none of these
  is kept as the site wrote it. CareerViet and ITviec show no experience on their
  lists, so it is empty for them.
- `salary` is the amount as the site writes it, without a label before it:
  CareerViet's "Lương: 15 - 25 Triệu VND" shows as "15 - 25 Triệu VND". It may
  also be "Cạnh tranh" (competitive) or "Thoả thuận" (negotiable).
- In `jobs.csv`, a cell that starts with `=`, `+`, `-` or `@` gets a leading `'`
  so a spreadsheet does not run it as a formula. `jobs.xlsx` stores its text cells
  as text, so they need no such mark.

## Using your own Chrome (macOS)

On a Mac with Chrome the tool reads the pages in the Google Chrome you already
use, with its logins, instead of in a browser the tool starts (`--my-chrome` says
the same and `--own-browser` turns it off). Chrome does not let outside programs
(Playwright and the like) control your everyday profile, so the tool uses a
feature Chrome has for this on macOS: AppleScript with "Allow JavaScript from
Apple Events".

One-time setup:

1. In a window of the Chrome profile you want to use, open View, then Developer,
   and tick **Allow JavaScript from Apple Events**. If you forget, the tool
   stops before it opens anything and prints: "Turn on "Allow JavaScript from
   Apple Events" in Chrome first: no Chrome profile has it on. Open Chrome in the
   profile whose logins you want to use, then choose View -> Developer -> Allow
   JavaScript from Apple Events (it gets a tick)." Chrome saves the setting within
   a few seconds, so run it again after that.

   The setting belongs to one profile, and its logins are the ones the pages see.
   The tool finds that profile by itself: it looks at each profile's saved settings
   for the setting, and when several have it on it takes the one you used last
   (the folder name, such as `Default` or `Profile 3`, is printed at the start of
   the run). `--chrome-profile="Profile 3"` picks one yourself
   (`chrome://version` shows the folder as Profile Path). The windows open in
   that profile whichever profile you used last. Windows used to open in whatever
   profile Chrome used last, and the setting was off whenever that was another
   profile (checked on 2026-11-27 with 13 profiles, only one of which had it on).
2. The first run, macOS may ask whether your terminal may control Google Chrome.
   Click Allow (System Settings, Privacy & Security, Automation, if you need to
   change it later).

Then run the usual command, with nothing added. The tool opens a window of its
own for each site, runs JavaScript only in that window, closes it and goes on. It
never quits Chrome, never touches your other tabs, and never reads your cookies,
history or passwords. A page sees a normal browser (`navigator.webdriver` is
`false`) with your logins already in place, so you log in to nothing.

- On 2026-11-27, with this mode, ITviec's list (pages 1 and 2) and TopCV's list
  (pages 1 and 2) loaded with no human check and no block, where the tool's own
  browser had met a check on ITviec and a block on TopCV. A full run in this mode
  then read all 28 ITviec pages and all 46 TopCV pages in about 25 minutes (TopCV
  showed two Cloudflare checks on the way, which the run waited out and passed).
  A site can still block you after many pages, so read `report.json`.
- **Speed.** Read one after another, a full run takes about 25 to 30 minutes, mostly
  the pause between pages and the time a page takes to load. With the defaults
  below the same run took 2 minutes 2 seconds on 2026-11-27, with up to 15 windows
  open at once (all of ITviec's 28 pages, TopCV's 47 and CareerViet's 9, each read
  once), and found the same 187 jobs as the one-by-one run. With 2 pages at once it
  took about 3 minutes 35 seconds. It reads at the same time, on two levels:
  - `--sites-at-once` (default 3) reads different sites together, each in its own
    window. Different sites are different servers, so this adds no load to any one
    of them.
  - `--pages-at-once` (default 5) reads several pages of one site together. Page 1
    says how many pages there are (ITviec "550 IT jobs" at 20 a page, TopCV
    "1 / 46 trang", CareerViet "441" at 50 a page), and pages 2 to N are then
    opened by their numbers in the address (`?page=7`, `-trang-7-`). It works for
    ITviec, TopCV and CareerViet. The company pages are one page each, and a
    site that scrolls without end has no page numbers, so those are read as before.

  Reading more pages of one site at once is faster but looks more like a robot, so a
  human check or a block is more likely, and ITviec sees your signed-in account.
  TopCV showed Cloudflare checks in the 5-at-once run (7 counted in the last part
  of the log), and each cleared by itself without a click. If a site starts asking
  for checks, use `--pages-at-once=2`, or 1. For the gentlest run
  use `--sites-at-once=1 --pages-at-once=1`. The first failure on a site stops it
  from starting new pages, and the jobs already read are kept, but first the site
  gets a second chance: when it blocks the windows, they are closed, the tool waits
  60 seconds, and the pages that were not read are read with 2 windows (TopCV did
  block 5 windows after about 10 pages in two runs on 2026-11-27, and read fine in
  the next). A second block ends the site. A page the site
  counted that comes back with no jobs is loaded once more first, because that was
  a hiccup in a test run (CareerViet gave two blank pages that had 50 jobs a
  minute later).
- **Quiet by default.** A window keeps a normal size (1300 by 700 pixels) and is
  parked at the right edge of the screen so that only a 32 pixel sliver shows.
  A tiny window did not work: CareerViet showed no job cards in a 200 by 120 one.
  Each worker reuses its window for all its pages, so a run opens a few windows
  instead of one per page, and the app you were using gets the focus back right
  after a window opens or navigates. A window comes forward at a normal size only
  while a Cloudflare check needs your click, and goes back after, and the app you
  were using gets the focus back too (once, when the last window that came forward
  goes back). Chrome also takes the focus by itself a second or two after a page
  starts loading, so for a few seconds after each page the app you were using is
  looked at and given the focus again if Chrome has just taken it. If you are in
  Chrome yourself, it leaves you alone. Opening tabs in one window instead of
  separate windows would not stop this (tested). `--show-windows` turns this off and opens
  windows at their usual size, in front. Even in quiet mode you may see the
  sliver. It cannot be made fully invisible: Chrome ignores AppleScript's
  minimize and hide (checked on Chrome 158), it will not run your logged-in
  profile without windows, and a headless browser is what Cloudflare blocked. The
  windows use the screen Chrome opened them on and the profile named by
  `--chrome-profile`.
- If you close one of its windows during a run, that site ends with "the Chrome
  window was closed".
- Nothing is installed, so Python's standard library is enough: no Playwright, no
  pip. Without a window to look at, a failure leaves a `.txt` of what the page said
  in `screenshots/`, not a picture.
- It only works on macOS. `--headless` and `--cache-dir` do nothing with it.

## Role, filtering and sorting in the sheet

**Role.** The `role` column holds the group of each title: Software Engineer,
Fullstack, Frontend, Backend, Mobile, Product Owner, Product Manager or Solution
Engineer, and nothing for a title in none of them. It sits next to the title
because a spreadsheet's filter list shows what the column holds: the filter on
`role` lists those groups, while the filter on `title` still lists every title as
the site wrote it ("Embedded Software Engineer", ".NET Developer", "Back End
Developer (C#)"). The rows are sorted by group, then company, then title, so
similar jobs sit together.

The group is worked out from the title:

- "Back End Developer (C#)", "Backend .NET Developer" and "Back-end Engineer
  (Java/NodeJS)" are Backend, and so are titles that only name a server stack next
  to Developer or Engineer: ".NET Developer", "ASP.NET Developer", "C# Developer",
  "Senior Java Engineer", "PHP Developer (Laravel)", "Python Developer", "Golang
  Developer", "Node.js Developer", "Ruby on Rails Developer". Not when the title is
  about data, machine learning, DevOps, site reliability, testing, automation,
  security, embedded or firmware work, games, blockchain, ERP, low-code, support
  or analysis ("Data Engineer (Python)", "QA Engineer (Java)", "Unity Game
  Developer (C#)", "Site Reliability Engineer (AWS, Python)"), and not
  "JavaScript Developer" (java is not javascript) or "Java Team Lead" (no
  developer word). The rule was checked on the 1,305 jobs of 2026-11-27, which
  put 68 jobs in Backend; it will still miss some and keep a few that are not.
- Android, iOS, Flutter and React Native titles are all Mobile; "Middle/Senior/Lead
  Software Engineer, Java" and "Software Engineer (Java, C#, Scala)" are both
  Software Engineer. Level words (Junior, Senior, Lead) are ignored.
- A title that names both Backend and Frontend, or Fullstack, is Fullstack.
- Backend, Frontend and the others are more specific than Software Engineer, so
  "Backend Software Engineer" is Backend.

`report.json` counts the jobs in each group (`role_groups`). `--role` also accepts
a job by its group, so `--role=Back-end` keeps ".NET Developer".

**Sorting.** The buttons on the header row sort a column, and that now sorts in the
order a person means:

- `posted` is a real date that shows as `Created at 27-11-2026` or `Edited at
  27-11-2026`. "Sort oldest to newest" and "newest to oldest" sort by the date,
  and the filter list groups the dates by year, month and day. Text with no date in
  it ("Closing soon") stays text.
- `experience` is stored as the years asked for and shown as the same text as
  before (`Entry-level`, `Under 1 year`, `4-5 years`, `5+ years`). It sorts as 0,
  0.5, then the years, with a range as its middle (`4-5 years` is 4.5) and `5+
  years` just after 5.
- `salary` shows one of a few levels in the sheet, because a filter list has one
  entry for every different text in a column (278 different salary texts in a
  1,304-job run, with "10 - 15 triệu" and "10 - 15 Triệu VND" apart). The filter
  on `salary` lists: `Thoả thuận` (negotiable, also "Thỏa thuận", "Negotiable",
  "Let's discuss"), `Cạnh tranh` (competitive, also "Competitive", "Attractive
  salary!", "High paid job"), `Không lương` (no pay), `Khác` (any other text),
  and the levels `Up to 10 triệu`, `10 - 20 triệu`, `20 - 30 triệu`, `30 - 50
  triệu`, `50 - 100 triệu` and `Over 100 triệu`, with blanks for no salary. A job
  is in the level of its top amount, the top included: "20 - 30 triệu" is in `20 -
  30 triệu` and "10 - 30 triệu" is too. Under the level is a number, the top
  amount in millions of dong, so "Sort smallest to largest" and "largest to
  smallest" put the lowest or the highest salaries first. Dollars are counted at
  25,000 dong, so "1,000 - 2,000 USD" is 50 and in `30 - 50 triệu`; that rate is a
  rough one, only used for the order and the level. The levels with no amount are
  below every amount (`Thoả thuận` -1, `Cạnh tranh` -2, `Không lương` -3, `Khác`
  -4), so they come first from smallest and last from largest. Jobs with no
  salary, no experience or no date always come last, whichever way you sort.
- The exact salary is in `jobs.csv`, in the `salary` column, as the site wrote it
  without the "Lương:" label. The sheet has no column for it, so it does not show
  there.
- The sheet keeps well under what Excel keeps: about 206 display formats in a
  workbook, and a sheet of 1,304 jobs now uses about 30 (the levels, the
  experience texts and two date formats). The sheet stops at 190 and writes the
  rest as plain text.

`jobs.csv` has the text of `posted` and `experience` as before, the exact `salary`, and a `role` column.

A Contains filter matches the letters you type, so `backend` does not find "Back
End" or "Back-end" in the `title` column; filter on `role` for that. The `--role`
option, used while collecting, treats those spellings as the same.

## Blocking and human checks

Both sites sit behind Cloudflare. On 2026-11-27 a plain `curl` got a 403 from
both, and one test run of this tool read the first list page of each site, then
met a "Verify you are human" check on ITviec's second page and a "you have been
blocked" page on TopCV's second page. Expect to get some pages, not all of them,
and read `report.json` to see what was missed.

- The Chrome window is visible by default. When Cloudflare shows a human check
  the tool waits, up to `--challenge-wait` seconds, for you to complete it in
  the window, and then carries on. The profile keeps the clearance for later runs.
- A "you have been blocked" page cannot be completed by a person. The tool
  records it, keeps the jobs already read and moves on to the next site.
- With `--headless` there is no window to click, so a check ends that site.
- If you close the Chrome window during a run, that site ends with the message
  "the Chrome window was closed", the sites not yet read are marked `skipped`,
  and the jobs already read are still saved.
- The tool does not hide that it is automated and does not try to get past a
  check or a block. If a site blocks it, try again later, with a larger
  `--delay`, or leave that site out with `--sources`.

## Sites not included

- **Indeed** (`vn.indeed.com`) loaded a first page on 2026-11-27, but its
  `robots.txt` allows only a few numbered result pages (`start=0` to `start=90`)
  and disallows many job paths, so a full crawl is not something the site permits.
  It was not built.
- **VietnamWorks** loaded, but its page uses generated class names, shows "100+"
  instead of a total and draws only some jobs at a time, so it needs a different
  approach (its own data requests) that has not been tried.

## Privacy and the sites' rules

In your own Chrome the tool never reads your cookies, logins or history, and it
never signs in; the pages see the logins your profile already has. To find the
profile it opens two of Chrome's own files in your Chrome folder, `Local State`
and each profile's `Preferences`, and uses one value from them: whether "Allow
JavaScript from Apple Events" is on, plus which profile you used last and in what
order they are listed. Nothing else is read from them, and nothing is stored or
sent. With `--own-browser` the tool uses its own browser profile and reads none
of that. The tool itself uploads nothing and sends nothing to Hub William. Pages
load as in any browser visit, so the sites' own scripts run and Chrome keeps its
usual background traffic, and with `--own-browser` the first run also contacts
PyPI to install Playwright.

It visits only the public job list pages. On 2026-11-27 the `robots.txt` of every
site allowed the page the tool opens for a generic crawler (checked with Python's
`robotparser`; Lecle has no `robots.txt`). ITviec disallows only
`/subscriptions/new`; TopCV disallows its CV and private paths; CareerViet
disallows `/api/`, `/vi/jobs/`, saved-job and résumé-search paths. The sites'
terms of use were not reviewed, so read them before you use the data beyond your
own search.

## Exit status

`0` when every site finished. `1` when a site did not (the files still hold what
was collected), or when the setup failed before anything was read, such as the
Chrome setting being off (a message says why). `2` for a wrong option.
