import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../workflows/contribution-policy.yml", import.meta.url),
  "utf8",
);
const ciWorkflow = readFileSync(
  new URL("../workflows/trusted-ci.yml", import.meta.url),
  "utf8",
);
const marker = "          script: |\n";
assert.equal(workflow.split(marker).length, 2, "Expected one policy script");
const source = workflow
  .split(marker)[1]
  .trimEnd()
  .split("\n")
  .map((line) => {
    if (line === "") return "";
    assert.ok(line.startsWith("            "), "Expected indented script");
    return line.slice(12);
  })
  .join("\n");
const validate = new (Object.getPrototypeOf(async function () {}).constructor)(
  "context",
  "github",
  "core",
  source,
);

const ownDoc = "contributors/alice/tools/my-tool/README.md";

test("full CI uses trusted workflow code and checks out only repository-owner PRs", () => {
  assert.match(ciWorkflow, /^  pull_request_target:/m);
  assert.doesNotMatch(ciWorkflow, /^  pull_request:/m);
  assert.match(
    ciWorkflow,
    /github\.event\.pull_request\.user\.login == github\.repository_owner/,
  );
  assert.match(
    ciWorkflow,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.match(
    ciWorkflow,
    /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  );
  assert.doesNotMatch(workflow, /actions\/checkout@/);
});

async function runPolicy({
  author = "alice",
  base = "dev",
  files = [{ filename: ownDoc, status: "added" }],
  entries,
  changedFiles = files.length,
  headSha = "head-sha",
  liveHeadSha = headSha,
  truncated = false,
} = {}) {
  const failures = [];
  const pr = {
    number: 12,
    user: { login: author },
    base: { ref: base },
    head: {
      sha: headSha,
      repo: { owner: { login: author }, name: "fork" },
    },
  };
  const github = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            head: { sha: liveHeadSha },
            base: { ref: base },
            changed_files: changedFiles,
          },
        }),
        listFiles: () => {},
      },
      git: {
        getTree: async () => ({
          data: {
            truncated,
            tree:
              entries ??
              files
                .filter((file) => file.status !== "removed")
                .map((file) => ({
                  path: file.filename,
                  type: "blob",
                  mode: "100644",
                })),
          },
        }),
      },
    },
    paginate: async () => files,
  };
  const core = {
    info: () => {},
    setFailed: (message) => failures.push(message),
  };
  await validate(
    {
      payload: { pull_request: pr },
      repo: { owner: "synasapmob", repo: "hub-william" },
    },
    github,
    core,
  );
  return failures;
}

test("accepts Markdown docs in the author's own tool folder", async () => {
  assert.deepEqual(await runPolicy(), []);
  assert.deepEqual(
    await runPolicy({ files: [{ filename: ownDoc, status: "removed" }] }),
    [],
  );
});

test("allows the repository owner to maintain code and release branches", async () => {
  assert.deepEqual(
    await runPolicy({
      author: "synasapmob",
      base: "main",
      files: [{ filename: "apps/api/src/main.rs", status: "modified" }],
    }),
    [],
  );
});

for (const filename of [
  "apps/api/src/main.rs",
  ".github/workflows/ci.yml",
  "contributors/default/tools/omp/omp.md",
  "contributors/bob/tools/my-tool/README.md",
  "contributors/alice/libraries/AGENTS.md",
  "contributors/alice/tools/my-tool/install.sh",
  "contributors/alice/tools/MyTool/README.md",
  "contributors/alice/tools/my-tool/.hidden.md",
]) {
  test(`rejects out-of-scope path ${filename}`, async () => {
    assert.equal(
      (await runPolicy({ files: [{ filename, status: "added" }] })).length,
      1,
    );
  });
}

test("rejects community PRs into main and renames from outside the author's folder", async () => {
  assert.equal((await runPolicy({ base: "main" })).length, 1);
  assert.equal(
    (
      await runPolicy({
        files: [
          {
            filename: ownDoc,
            previous_filename: "contributors/default/tools/omp/omp.md",
            status: "renamed",
          },
        ],
      })
    ).length,
    1,
  );
});

for (const mode of ["100755", "120000", "160000"]) {
  test(`rejects unsafe Git file mode ${mode}`, async () => {
    assert.equal(
      (
        await runPolicy({
          entries: [{ path: ownDoc, type: "blob", mode }],
        })
      ).length,
      1,
    );
  });
}

test("fails closed on stale or incomplete GitHub API data", async () => {
  assert.equal((await runPolicy({ liveHeadSha: "newer-head" })).length, 1);
  assert.equal((await runPolicy({ changedFiles: 2 })).length, 1);
  assert.equal((await runPolicy({ truncated: true })).length, 1);
});
