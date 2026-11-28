import { describe, expect, it } from "vitest";

import {
  JOB_CRAWLER_BOARDS,
  JOB_CRAWLER_INITIAL_CHOICES,
  JOB_CRAWLER_ROLES,
  JOB_CRAWLER_SITES,
  jobCrawlerCommand,
  toggledChoice,
} from "./utils.job-crawler-command";

const SCRIPT = "https://hub.example/catalog/job-crawler.py";

describe("jobCrawlerCommand", () => {
  it("writes no option when nothing is picked, so the tool collects everything with its own defaults", () => {
    expect(jobCrawlerCommand(SCRIPT, JOB_CRAWLER_INITIAL_CHOICES)).toBe(
      `curl -fsSL ${SCRIPT} | python3`,
    );
  });

  it("leaves the folder out when it is only spaces", () => {
    expect(
      jobCrawlerCommand(SCRIPT, {
        ...JOB_CRAWLER_INITIAL_CHOICES,
        outputDir: "   ",
      }),
    ).toBe(`curl -fsSL ${SCRIPT} | python3`);
  });

  it("writes each pick as the option the tool reads", () => {
    expect(
      jobCrawlerCommand(SCRIPT, {
        sources: ["itviec", "topcv"],
        roles: ["Fullstack", "Backend"],
        locations: ["HCM", "Remote"],
        days: 60,
        outputDir: "~/Documents/jobs",
      }),
    ).toBe(
      `curl -fsSL ${SCRIPT} | python3 - --output-dir=~/Documents/jobs --sources=itviec,topcv --role=Fullstack,Backend --location=HCM,Remote --date=60`,
    );
  });

  it("quotes a place that has a space in it", () => {
    expect(
      jobCrawlerCommand(SCRIPT, {
        ...JOB_CRAWLER_INITIAL_CHOICES,
        outputDir: "",
        locations: ["HN", "Da Nang"],
      }),
    ).toBe(`curl -fsSL ${SCRIPT} | python3 - --location='HN,Da Nang'`);
  });

  it("quotes a role list that has a space in it", () => {
    expect(
      jobCrawlerCommand(SCRIPT, {
        ...JOB_CRAWLER_INITIAL_CHOICES,
        outputDir: "",
        roles: ["Software Engineer"],
      }),
    ).toBe(`curl -fsSL ${SCRIPT} | python3 - --role='Software Engineer'`);
  });

  it("writes --date for a day count that was picked, including 0 for any date", () => {
    expect(
      jobCrawlerCommand(SCRIPT, { ...JOB_CRAWLER_INITIAL_CHOICES, days: 0 }),
    ).toBe(`curl -fsSL ${SCRIPT} | python3 - --date=0`);
    expect(
      jobCrawlerCommand(SCRIPT, { ...JOB_CRAWLER_INITIAL_CHOICES, days: 30 }),
    ).toBe(`curl -fsSL ${SCRIPT} | python3 - --date=30`);
  });

  it("keeps a folder with a space or a quote in it as one word", () => {
    expect(
      jobCrawlerCommand(SCRIPT, {
        ...JOB_CRAWLER_INITIAL_CHOICES,
        outputDir: "~/My Jobs",
      }),
    ).toBe(`curl -fsSL ${SCRIPT} | python3 - --output-dir='~/My Jobs'`);
    expect(
      jobCrawlerCommand(SCRIPT, {
        ...JOB_CRAWLER_INITIAL_CHOICES,
        outputDir: "~/it's; rm -rf x",
      }),
    ).toBe(
      `curl -fsSL ${SCRIPT} | python3 - --output-dir='~/it'\\''s; rm -rf x'`,
    );
  });
});

describe("toggledChoice", () => {
  it("adds a pick and removes it again", () => {
    expect(toggledChoice(JOB_CRAWLER_BOARDS, [], "topcv")).toEqual(["topcv"]);
    expect(toggledChoice(JOB_CRAWLER_BOARDS, ["topcv"], "topcv")).toEqual([]);
  });

  it("keeps the order of the catalogue, not the order of the clicks", () => {
    const afterTopcv = toggledChoice(JOB_CRAWLER_SITES, [], "topcv");
    const afterItviec = toggledChoice(JOB_CRAWLER_SITES, afterTopcv, "itviec");
    const afterIndeed = toggledChoice(JOB_CRAWLER_SITES, afterItviec, "indeed");
    const afterAxon = toggledChoice(JOB_CRAWLER_SITES, afterIndeed, "axon");

    expect(afterAxon).toEqual(["itviec", "topcv", "indeed", "axon"]);
  });

  it("drops a value that is not one of the options", () => {
    expect(toggledChoice(JOB_CRAWLER_ROLES, ["Backend"], "Gardener")).toEqual([
      "Backend",
    ]);
  });
});
