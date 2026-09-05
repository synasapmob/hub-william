import { describe, expect, it } from "vitest";

import {
  allowsMissingJobDeactivation,
  collectOffsetPages,
  isMarketLocation,
  parseJob,
  type RawJob,
} from "./job-market";

const rawJob: RawJob = {
  sourceId: "test",
  companyId: "grab",
  externalId: "job-1",
  sourceUrl: "https://example.com/job-1",
  title: "Senior Front-end Engineer",
  companyName: "Grab",
  companyLogoUrl: null,
  descriptionHtml: `
    <h2>Must have</h2>
    <ul>
      <li>Strong experience with React and TypeScript.</li>
      <li>Professional English communication.</li>
    </ul>
    <h2>Nice to have</h2>
    <ul>
      <li>Experience with Redux and AWS is a bonus.</li>
    </ul>
  `,
  descriptionQuality: "full",
  locationText: "Ho Chi Minh City, Vietnam",
  employmentType: "Full-time",
  postedAt: new Date().toISOString(),
  salaryText: null,
  explicitSeniority: null,
  payload: {},
};

describe("job-market parser", () => {
  it("uses requirement section headings without an LLM", async () => {
    const parsed = await parseJob(rawJob);

    expect(parsed?.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "react", requirement: "required" }),
        expect.objectContaining({
          slug: "typescript",
          requirement: "required",
        }),
        expect.objectContaining({ slug: "redux", requirement: "preferred" }),
        expect.objectContaining({ slug: "aws", requirement: "preferred" }),
      ]),
    );
    expect(parsed?.roleTags).toContain("frontend");
  });

  it("keeps software-engineering roles in their exact category", async () => {
    const parsed = await parseJob({
      ...rawJob,
      externalId: "job-software-engineer",
      title: "Senior Software Engineer",
      descriptionHtml:
        "<p>Build ReactJS interfaces and Golang microservices.</p>",
    });

    expect(parsed?.roleTags).toEqual(["software-engineering"]);
  });

  it("tags frontend software roles as both frontend and software-engineering", async () => {
    const parsed = await parseJob({
      ...rawJob,
      externalId: "job-frontend-swe",
      title: "Frontend Software Engineer I",
    });

    expect(parsed?.category).toBe("frontend");
    expect(parsed?.roleTags).toEqual(["frontend", "software-engineering"]);
  });

  it("collects mobile, fullstack, ML, and engineering-manager titles", async () => {
    const titles = [
      "Android Engineer I",
      "(Junior/Senior) Mobile iOS Engineer",
      "FullStack Member of Technical Staff II",
      "Machine Learning Engineer II",
      "Engineering Manager, DevX",
    ];

    for (const title of titles) {
      const parsed = await parseJob({
        ...rawJob,
        externalId: title,
        title,
      });
      expect(parsed?.roleTags, title).toContain("software-engineering");
    }
  });

  it("uses Greenhouse job family when the title is not enough", async () => {
    const parsed = await parseJob({
      ...rawJob,
      externalId: "job-family",
      title: "Member of Staff, Platform",
      payload: {
        metadata: [
          { name: "Job Family Group", value: "Engineering" },
          { name: "Job Family", value: "Software Engineering" },
        ],
      },
    });

    expect(parsed?.roleTags).toContain("software-engineering");
  });

  it("does not treat US state-remote locations as the market", () => {
    expect(isMarketLocation("Ho Chi Minh City, Vietnam")).toBe(true);
    expect(isMarketLocation("Singapore")).toBe(true);
    expect(isMarketLocation("Australia")).toBe(true);
    expect(isMarketLocation("Remote")).toBe(true);
    expect(isMarketLocation("Kentucky-Remote")).toBe(false);
    expect(isMarketLocation("Florida-Remote")).toBe(false);
    expect(isMarketLocation("Remote, United States")).toBe(false);
    expect(isMarketLocation("Seattle, Washington, United States")).toBe(false);
  });

  it("ignores roles and companies outside the fixed scope", async () => {
    const unrelatedRole = await parseJob({
      ...rawJob,
      externalId: "job-devops",
      title: "DevOps Engineer",
    });
    const unrelatedCompany = await parseJob({
      ...rawJob,
      companyId: null,
      companyName: "Supabase",
      externalId: "job-other-company",
    });

    expect(unrelatedRole).toBeNull();
    expect(unrelatedCompany).toBeNull();
  });

  it("does not classify ordinary English 'next' as Next.js", async () => {
    const parsed = await parseJob({
      ...rawJob,
      externalId: "job-2",
      descriptionHtml:
        "<p>Build the next generation of React products with TypeScript.</p>",
    });

    expect(parsed?.skills.some((skill) => skill.slug === "nextjs")).toBe(false);
  });
});

describe("pagination audit", () => {
  it("allows deactivation only for a proven complete snapshot", () => {
    expect(allowsMissingJobDeactivation(true, "complete")).toBe(true);
    expect(allowsMissingJobDeactivation(true, "partial")).toBe(false);
    expect(allowsMissingJobDeactivation(true, "unknown")).toBe(false);
    expect(allowsMissingJobDeactivation(false, "complete")).toBe(false);
  });

  it("keeps fetching until the upstream total is reached", async () => {
    const items = Array.from({ length: 25 }, (_, index) => ({
      id: String(index + 1),
    }));
    const starts: number[] = [];
    const result = await collectOffsetPages(
      async (start) => {
        starts.push(start);
        return { items: items.slice(start, start + 10), expectedTotal: 25 };
      },
      (item) => item.id,
      { pageSize: 10 },
    );

    expect(starts).toEqual([0, 10, 20]);
    expect(result).toEqual(
      expect.objectContaining({
        expectedTotal: 25,
        pagesFetched: 3,
        rawItemsFetched: 25,
        coverageStatus: "complete",
        stopReason: "expected-total-reached",
      }),
    );
    expect(result.items).toHaveLength(25);
  });

  it("marks a premature empty page incomplete", async () => {
    const firstPage = Array.from({ length: 10 }, (_, index) => ({
      id: String(index + 1),
    }));
    const result = await collectOffsetPages(
      async (start) => ({
        items: start === 0 ? firstPage : [],
        expectedTotal: 20,
      }),
      (item) => item.id,
      { pageSize: 10 },
    );

    expect(result.coverageStatus).toBe("partial");
    expect(result.stopReason).toBe("premature-empty-page");
    expect(result.items).toHaveLength(10);
  });

  it("stops repeated pages instead of looping forever", async () => {
    const repeated = Array.from({ length: 10 }, (_, index) => ({
      id: String(index + 1),
    }));
    const result = await collectOffsetPages(
      async () => ({ items: repeated, expectedTotal: 30 }),
      (item) => item.id,
      { pageSize: 10 },
    );

    expect(result.coverageStatus).toBe("partial");
    expect(result.stopReason).toBe("repeated-page");
    expect(result.pagesFetched).toBe(2);
    expect(result.rawItemsFetched).toBe(20);
    expect(result.items).toHaveLength(10);
  });
});
