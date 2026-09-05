import { tv } from "tailwind-variants";

/** The stage dot. Its own table: nothing else in the schematic reads the stage. */
const stageDot = tv({
  base: "size-2 shrink-0 rounded-full",
  variants: {
    tone: {
      indigo: "bg-indigo-400",
      emerald: "bg-emerald-400",
      amber: "bg-amber-400",
      purple: "bg-purple-400",
    },
  },
});

interface PipelineStage {
  step: string;
  tone: "indigo" | "emerald" | "amber" | "purple";
  title: string;
  detail: string;
  /** How control reaches the next stage. Absent on the last one, which ends the pipeline. */
  handoff?: string;
}

const stages: PipelineStage[] = [
  {
    step: "[1]",
    tone: "indigo",
    title: "User task prompt",
    detail: "Ingress & intent resolution",
    handoff: "passes through boundary",
  },
  {
    step: "[2]",
    tone: "indigo",
    title: "Harness environment",
    detail: "Loads rules, tool restrictions, compiler sandbox",
    handoff: "triggers cognitive loop",
  },
  {
    step: "[3]",
    tone: "emerald",
    title: "Agent reasoning + skills",
    detail: "Dynamic AST parsing & vector memory queries",
    handoff: "intercepted before tool writes",
  },
  {
    step: "[4]",
    tone: "amber",
    title: "Pre / post hook interceptors",
    detail: "Auto-test runner & conventional commit guard",
    handoff: "streams telemetry",
  },
  {
    step: "[5]",
    tone: "purple",
    title: "Telemetry & heatmap observer",
    detail: "Token auditing, run duration, failure metrics",
  },
];

export default function RuntimePipeline() {
  return (
    <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6 font-mono text-xs text-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
        <p className="text-zinc-400">Dataflow schematic</p>
        <p className="text-emerald-400">Status: concurrent pipeline</p>
      </div>

      <ol className="space-y-3 text-xs">
        {stages.map((stage) => (
          <li key={stage.step}>
            <div className="flex flex-col gap-1 rounded-lg border border-zinc-700/60 bg-zinc-800/80 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <p className="flex items-center gap-2 font-semibold text-zinc-200">
                <span
                  aria-hidden="true"
                  className={stageDot({ tone: stage.tone })}
                />
                {stage.step} {stage.title}
              </p>

              <p className="text-[10px] text-zinc-400">{stage.detail}</p>
            </div>

            {stage.handoff ? (
              <p className="pt-3 text-center text-zinc-500">
                <span aria-hidden="true">↓ </span>
                {stage.handoff}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
