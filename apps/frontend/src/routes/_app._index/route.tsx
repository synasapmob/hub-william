import type { ReactNode } from "react";
import { Boxes, ExternalLink, Users, Wrench } from "lucide-react";
import { Link } from "react-router";

import CopyBlock from "@/components/copy-block";
import Flex from "@/components/ui/flex";
import { GITHUB_REPOSITORY_URL } from "@/services/catalog";

const CONTRIBUTION_TREE = `contributors/
├── default/                  # system (read-only)
│   └── tools/
│       ├── gateway/
│       ├── opencode/
│       └── omp/
└── <your-github-login>/       # your contributions
    └── tools/
        └── <tool-name>/
            └── README.md`;

interface WhitepaperSectionProps {
  children: ReactNode;
  index: string;
  title: string;
}

function WhitepaperSection({ children, index, title }: WhitepaperSectionProps) {
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

export default function HomeRoute() {
  return (
    <article
      aria-labelledby="whitepaper-title"
      className="mx-auto w-full max-w-4xl space-y-12 px-6 pt-12 pb-24 text-left"
    >
      <header className="space-y-4 border-b border-border pb-10">
        <p className="flex items-center gap-2 font-mono text-xs font-medium tracking-wider text-indigo-600 uppercase">
          <Boxes aria-hidden="true" className="size-4" />
          White paper
        </p>

        <h1
          id="whitepaper-title"
          className="font-bold tracking-tight text-balance text-3xl/tight sm:text-4xl"
        >
          Hub William: tools and agents, shared with your team
        </h1>

        <p className="max-w-3xl text-muted-foreground text-base/relaxed">
          Hub William is a place to share useful tools and agent access.
          Contributors can publish tools and improve existing ones, while
          account owners can create agent pools and share access with teammates
          through the gateway.
        </p>
      </header>

      <WhitepaperSection
        index="01. Why Hub William"
        title="Share access without passing around provider credentials"
      >
        <div className="space-y-4 text-zinc-700 text-sm/relaxed">
          <p>
            Sharing an account directly means handing out credentials and
            managing access across teammates' devices. Hub William keeps the
            provider connection on the server. Owners manage who can join a
            pool, and approved teammates use their own Hub gateway keys.
          </p>

          <p>
            Requests pass through a shared gateway instead of requiring every
            teammate to sign in to the provider account from their own machine.
            This centralizes upstream access and makes membership and key
            revocation easier to manage. Provider usage limits and account
            policies still apply; a shared gateway does not guarantee protection
            from an account ban.
          </p>

          <p>
            Agents brings connected accounts, usage and pool membership
            together. Tools contains setup instructions and integrations,
            including Gateway, OpenCode and OMP. Playground lets you try models
            using your connected accounts and approved pools.
          </p>

          <Flex className="flex-wrap items-center gap-3 pt-1">
            <Link
              to="/agents"
              className="flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium tracking-tight text-white shadow-xs transition-colors hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
            >
              <Users aria-hidden="true" className="size-3.5" />
              Explore agents
            </Link>

            <Link
              to="/tools"
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium tracking-tight text-zinc-700 transition-colors hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
            >
              <Wrench aria-hidden="true" className="size-3.5" />
              Browse tools
            </Link>
          </Flex>
        </div>
      </WhitepaperSection>

      <WhitepaperSection
        index="02. How to contribute"
        title="Useful tools grow through contributions"
      >
        <div className="space-y-4 text-zinc-700 text-sm/relaxed">
          <p>
            Contribute a tool through a pull request. Each contributor owns a
            folder named after their GitHub username, with tool documentation
            written in Markdown.
          </p>

          <CopyBlock source={CONTRIBUTION_TREE} />

          <p>
            <strong className="font-semibold text-foreground">
              The default folder belongs to the system.
            </strong>{" "}
            It is read-only for contributors: do not edit, rename or delete
            anything under <code>contributors/default/</code>. Add your own
            username folder instead and keep your contributions inside it.
          </p>

          <ol className="list-decimal space-y-4 pl-5 marker:font-mono marker:text-zinc-400">
            <li>Fork the repository and branch from dev.</li>

            <li>
              Create{" "}
              <code className="break-all font-mono text-xs">
                contributors/&lt;your-github-login&gt;/tools/&lt;tool-name&gt;/
              </code>{" "}
              and add a <code>README.md</code> describing your tool. You can
              update tools inside your own contributor folder.
            </li>

            <li>
              Open a pull request into dev with a description of the change and
              the checks you ran.
            </li>
          </ol>

          <a
            href={GITHUB_REPOSITORY_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium tracking-tight text-zinc-700 transition-colors hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
          >
            Contribute on GitHub
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        </div>
      </WhitepaperSection>
    </article>
  );
}
