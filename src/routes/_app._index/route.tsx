import type { ReactNode } from "react";
import { Boxes, ExternalLink, Layers } from "lucide-react";
import { Link } from "react-router";

import Flex from "@/components/ui/flex";
import CopyBlock from "@/components/copy-block";
import InstallCommands from "@/components/install-commands";
import { GITHUB_REPOSITORY_URL } from "@/services/catalog";

/**
 * The folder a contributor files their documents under.
 *
 * Shown as a snippet rather than prose because the four kinds are the whole
 * convention: the folder decides what an entry becomes, so a reader copying the
 * tree has already made every decision the catalogue asks of them.
 */
const CONTRIBUTION_TREE = `contributors/<your-github-login>/
├── libraries/
│   ├── harness/<name>.md          an execution mode
│   ├── skills/<name>/SKILL.md     a skill, with YAML front matter
│   ├── hooks/<name>.md            a contract that fires around an action
│   └── templates/<name>.md        a shape to write into
└── tools/
    └── <name>/<name>.md           how to install or run something`;

interface InlineCodeProps {
  children: ReactNode;
}

function InlineCode({ children }: InlineCodeProps) {
  return (
    <code className="rounded border border-zinc-200 bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] text-zinc-800">
      {children}
    </code>
  );
}

interface SpecificationSectionProps {
  children: ReactNode;
  index: string;
  title: string;
}

function SpecificationSection({
  children,
  index,
  title,
}: SpecificationSectionProps) {
  return (
    <section className="space-y-4">
      <p className="font-mono text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {index}
      </p>

      <h2 className="text-2xl font-bold tracking-tight">{title}</h2>

      {children}
    </section>
  );
}

export default function WhitepaperRoute() {
  return (
    <article
      aria-labelledby="whitepaper-title"
      className="mx-auto w-full max-w-4xl space-y-12 px-6 pt-12 pb-24 text-left"
    >
      <header className="space-y-4 border-b border-border pb-10">
        <p className="flex items-center gap-2 font-mono text-xs font-medium tracking-wider text-indigo-600 uppercase">
          <Boxes aria-hidden="true" className="size-4" />
          White paper &amp; system architecture
        </p>

        <h1
          id="whitepaper-title"
          className="font-bold tracking-tight text-balance text-3xl/tight sm:text-4xl"
        >
          Hub-William: the boundary an agent must not cross, written down
        </h1>

        <p className="max-w-3xl text-muted-foreground text-base/relaxed">
          An agent given a whole codebase and a shell has no boundary it must
          not cross, and nothing that fires when it tries. Hub-William writes
          that boundary down in four kinds of document —{" "}
          <strong className="font-semibold text-foreground">Harnesses</strong>,{" "}
          <strong className="font-semibold text-foreground">Skills</strong>,{" "}
          <strong className="font-semibold text-foreground">Hooks</strong> and{" "}
          <strong className="font-semibold text-foreground">Templates</strong> —
          and every one of them is a Markdown file in this repository. That is
          the point: a boundary you can read, review in a diff, and disagree
          with.
        </p>
      </header>

      <SpecificationSection
        index="01. The problem"
        title="Why prompting harder does not fix it"
      >
        <div className="space-y-3 text-zinc-700 text-sm/relaxed">
          <p>
            Contemporary AI coding agents suffer from fundamental systemic
            limitations: prompt bloat, memory degradation across long contexts,
            accidental destructive overwrites, and failure to honor
            repository-specific architectural rules.
          </p>

          <p>
            When an agent is given an entire codebase and free rein over raw
            shell commands, it frequently hallucinates non-existent
            dependencies, breaks existing unit tests, violates project
            conventions, and opens a pull request nobody can review.
          </p>

          <p className="rounded-xl border border-amber-200/80 bg-amber-50/70 p-4 font-mono text-amber-900 text-xs/relaxed">
            <strong>Core hypothesis:</strong> the failure is not a wording
            problem, so it does not have a wording fix. An agent needs a
            boundary written down where it can be read — harnesses it executes
            inside, skills that carry one discipline&rsquo;s rules, and hooks
            that fire around the actions leaving the checkout.
          </p>
        </div>
      </SpecificationSection>

      <SpecificationSection
        index="02. How to contribute"
        title="Everything is a Markdown file, so a contribution is a pull request"
      >
        <div className="space-y-4 text-zinc-700 text-sm/relaxed">
          <p>
            Everything on the canvas is a Markdown file, so contributing is
            opening a pull request that adds one. There is no upload, no
            account, and nothing to run.
          </p>

          <ol className="list-decimal space-y-4 pl-5 marker:font-mono marker:text-zinc-400">
            <li>Fork the repository.</li>

            <li className="space-y-3">
              <p>
                Create{" "}
                <InlineCode>
                  contributors/default/contrib/&lt;your-github-login&gt;/
                </InlineCode>{" "}
                and file your document under the kind it is.
              </p>

              <CopyBlock source={CONTRIBUTION_TREE} />

              <p>
                The folder name has to be your GitHub login. That is what
                publishes your page at{" "}
                <InlineCode>/library/&lt;your-login&gt;</InlineCode>, and what
                resolves your avatar beside it without an API call or a stored
                file.
              </p>
            </li>

            <li>
              Write the document. A heading and a first paragraph are enough —
              the site takes the entry&rsquo;s name and description from them,
              and never edits your file. A skill also needs{" "}
              <InlineCode>name</InlineCode> and{" "}
              <InlineCode>description</InlineCode> front matter, because that is
              what its format requires.
            </li>

            <li>
              Open a pull request. CI runs formatting, linting, type checking,
              tests, a production build and the catalogue&rsquo;s own suite.
              Once it merges your page is prerendered and deployed — nobody has
              to register it anywhere.
            </li>
          </ol>

          <p>
            Changing a shared document is the same flow without step 2. Say in
            the pull request why the rule should apply to everybody rather than
            to you; that is the whole difference between the two folders.
          </p>

          <Flex className="items-center gap-3 flex-wrap pt-1">
            <Link
              to="/library"
              className="flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium tracking-tight text-white shadow-xs transition-colors hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
            >
              <Layers aria-hidden="true" className="size-3.5" />
              Read the catalogue
            </Link>

            <a
              href={GITHUB_REPOSITORY_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium tracking-tight text-zinc-700 transition-colors hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
            >
              synasapmob/hub-william on GitHub
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          </Flex>
        </div>
      </SpecificationSection>

      <SpecificationSection
        index="03. How to use"
        title="Install the catalogue on your machine"
      >
        <div className="space-y-4 text-zinc-700 text-sm/relaxed">
          <p>
            There is deliberately no wrapper command to install first. A wrapper
            is one more thing that has to be present and correct before you can
            fix anything, and this is the tool you reach for when a machine is
            not set up yet — so the installer is a script in the repository, and
            cloning it is the install.
          </p>

          <InstallCommands />

          <div className="space-y-2">
            <p className="font-mono text-xs font-semibold tracking-wider text-zinc-700 uppercase">
              What it needs on the machine
            </p>

            <ul className="list-disc space-y-1.5 pl-5 marker:text-zinc-400">
              <li>
                <InlineCode>python3</InlineCode> 3.8 or newer on{" "}
                <InlineCode>PATH</InlineCode>. macOS ships one at{" "}
                <InlineCode>/usr/bin/python3</InlineCode> and most Linux
                distributions already have one; with nothing new enough the
                script stops before it does anything.
              </li>

              <li>
                At least one agent CLI on <InlineCode>PATH</InlineCode> —{" "}
                <InlineCode>claude</InlineCode>, <InlineCode>codex</InlineCode>{" "}
                or <InlineCode>grok</InlineCode>. With none of them installed,{" "}
                <InlineCode>init</InlineCode> stops with{" "}
                <InlineCode>no agent CLI on PATH</InlineCode> rather than
                installing documents no agent will read.
              </li>
            </ul>
          </div>

          <p>
            <InlineCode>init</InlineCode> draws the catalogue as a picker: the
            arrow keys move, space toggles an item on or off, and enter applies.
            It prints the plan and asks once before touching anything, then
            installs what you selected into each agent&rsquo;s home as read-only
            copies — the checkout stays the editable source, and the copies are
            regenerated from it rather than edited in place.
          </p>
        </div>
      </SpecificationSection>
    </article>
  );
}
