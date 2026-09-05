import type { ReactNode } from "react";
import { Activity, ArrowRight, Boxes, Layers, Sparkles } from "lucide-react";
import { Link } from "react-router";

import Flex from "@/components/flex";

import ArchitecturePrimitives from "./architecture-primitives";
import DeveloperInterface from "./developer-interface";
import RuntimePipeline from "./runtime-pipeline";

interface DocumentFact {
  label: string;
  value: string;
}

const documentFacts: DocumentFact[] = [
  { label: "Author", value: "William Core Architecture" },
  { label: "Ecosystem", value: "Multi-Agent Runtimes" },
  { label: "License", value: "Apache 2.0 / Open Spec" },
  { label: "Published", value: "September 2026" },
];

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
    <div className="w-full pb-24 text-left">
      <div className="sticky top-0 z-20 border-b border-zinc-200/80 bg-card">
        <Flex
          justify="between"
          wrap
          gap="sm"
          className="mx-auto max-w-4xl px-6 py-3"
        >
          <Flex gap="sm" wrap className="font-mono text-[11px]">
            <p className="font-semibold">Specification RFC-014</p>
            <p className="text-muted-foreground">Hub-William runtime v1.4</p>
            <p className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-emerald-700">
              Stable architecture
            </p>
          </Flex>

          <Link
            to="/library"
            className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium tracking-tight text-white shadow-xs transition-colors hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
          >
            <Layers aria-hidden="true" className="size-3.5" />
            Explore agent library canvas
          </Link>
        </Flex>
      </div>

      <article
        aria-labelledby="whitepaper-title"
        className="mx-auto max-w-4xl space-y-12 px-6 pt-12"
      >
        <header className="space-y-4 border-b border-border pb-10">
          <p className="flex items-center gap-2 font-mono text-xs font-medium tracking-wider text-indigo-600 uppercase">
            <Boxes aria-hidden="true" className="size-4" />
            White paper & system architecture
          </p>

          <h1
            id="whitepaper-title"
            className="text-3xl leading-tight font-bold tracking-tight text-balance sm:text-4xl"
          >
            Hub-William: modular workspace & deterministic runtime for
            engineering agents
          </h1>

          <p className="max-w-3xl text-base leading-relaxed text-muted-foreground">
            An open specification and execution fabric for structuring AI
            developer agents. By isolating execution boundaries into{" "}
            <strong className="font-semibold text-foreground">Harnesses</strong>
            , composable reasoning into{" "}
            <strong className="font-semibold text-foreground">Skills</strong>,
            and lifecycle hooks into{" "}
            <strong className="font-semibold text-foreground">
              Interceptors
            </strong>
            , Hub-William prevents context drift, enforces zero-hallucination
            guardrails, and provides real-time observability across autonomous
            agent fleets.
          </p>

          <dl className="grid grid-cols-2 gap-4 border-t border-zinc-100 pt-4 font-mono text-xs sm:grid-cols-4">
            {documentFacts.map((fact) => (
              <div key={fact.label}>
                <dt className="text-[10px] text-zinc-400 uppercase">
                  {fact.label}
                </dt>
                <dd className="mt-0.5 font-medium text-zinc-800">
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        </header>

        <SpecificationSection
          index="01. The problem"
          title="Why prompt engineering fails at production scale"
        >
          <div className="space-y-3 text-sm leading-relaxed text-zinc-700">
            <p>
              Contemporary AI coding agents suffer from fundamental systemic
              limitations: prompt bloat, memory degradation across long
              contexts, accidental destructive overwrites, and failure to honor
              repository-specific architectural rules.
            </p>

            <p>
              When an agent is given an entire codebase and free rein over raw
              shell commands, it frequently hallucinates non-existent
              dependencies, breaks existing unit tests, violates project
              conventions, and produces unmaintainable pull requests.
            </p>

            <p className="rounded-xl border border-amber-200/80 bg-amber-50/70 p-4 font-mono text-xs leading-relaxed text-amber-900">
              <strong>Core hypothesis:</strong> Autonomous software development
              requires deterministic boundary isolation. Agents must execute
              inside defined harnesses with granular cognitive skills and
              pre/post lifecycle hooks.
            </p>
          </div>
        </SpecificationSection>

        <SpecificationSection
          index="02. Architectural primitives"
          title="The triad: harnesses, skills, and hooks"
        >
          <p className="text-sm leading-relaxed text-zinc-700">
            Hub-William decouples agent configuration into three orthogonal,
            reusable primitives:
          </p>

          <ArchitecturePrimitives />
        </SpecificationSection>

        <SpecificationSection
          index="03. Runtime pipeline"
          title="Deterministic execution pipeline"
        >
          <RuntimePipeline />
        </SpecificationSection>

        <SpecificationSection
          index="04. Developer interface"
          title="CLI & workspace operations"
        >
          <p className="text-sm leading-relaxed text-zinc-700">
            Hub-William is managed seamlessly via the command line or directly
            configured through the visual canvas library.
          </p>

          <DeveloperInterface />
        </SpecificationSection>

        <section className="space-y-4 rounded-2xl bg-linear-to-br from-zinc-900 to-zinc-800 p-6 text-white sm:p-8">
          <p className="flex items-center gap-2 font-mono text-xs text-indigo-300">
            <Sparkles aria-hidden="true" className="size-4" />
            Explore the living ecosystem
          </p>

          <h2 className="text-xl font-bold tracking-tight">
            Ready to explore and configure agent components?
          </h2>

          <p className="max-w-2xl text-xs leading-relaxed text-zinc-300 sm:text-sm">
            Inspect the visual canvas layout of all available harnesses, skills,
            and hooks in the agent library, or monitor run frequencies and token
            consumption in agent activities.
          </p>

          <Flex gap="md" wrap className="pt-2">
            <Link
              to="/library"
              className="flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-xs font-semibold tracking-tight text-zinc-900 shadow-xs transition-colors hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-hidden"
            >
              <Layers aria-hidden="true" className="size-4" />
              Open agent library canvas
              <ArrowRight aria-hidden="true" className="size-3.5" />
            </Link>

            <Link
              to="/activities"
              className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-xs font-semibold tracking-tight text-white transition-colors hover:bg-zinc-700 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-hidden"
            >
              <Activity aria-hidden="true" className="size-4 text-zinc-400" />
              View agent activities telemetry
            </Link>
          </Flex>
        </section>
      </article>
    </div>
  );
}
