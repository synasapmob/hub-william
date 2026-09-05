import { tv } from "tailwind-variants";

/**
 * The numbered chip and the discipline line under each title read the same
 * primitive, so one table with slots feeds both — split apart, a card could end
 * up amber above and emerald below.
 */
const primitiveTone = tv({
  slots: {
    chip: "mb-3 grid size-8 place-items-center rounded-lg border font-mono text-xs font-bold",
    discipline: "mt-0.5 font-mono text-[11px] uppercase",
  },
  variants: {
    tone: {
      indigo: {
        chip: "border-indigo-200 bg-indigo-50 text-indigo-700",
        discipline: "text-indigo-600",
      },
      emerald: {
        chip: "border-emerald-200 bg-emerald-50 text-emerald-700",
        discipline: "text-emerald-600",
      },
      amber: {
        chip: "border-amber-200 bg-amber-50 text-amber-700",
        discipline: "text-amber-600",
      },
    },
  },
});

interface ArchitecturePrimitive {
  index: string;
  tone: "indigo" | "emerald" | "amber";
  name: string;
  discipline: string;
  description: string;
  guarantees: string;
}

const primitives: ArchitecturePrimitive[] = [
  {
    index: "01",
    tone: "indigo",
    name: "Harnesses",
    discipline: "Execution boundary",
    description:
      "Defines the isolated runtime container, allowed file trees, compiler toolchain, and strict contracts for a specific domain (e.g. React/Next.js, Node/Express, PyTorch).",
    guarantees: "Guarantees: Zero drift, sandbox isolation",
  },
  {
    index: "02",
    tone: "emerald",
    name: "Skills",
    discipline: "Cognitive capability",
    description:
      "Specialized domain models and AST parsers injected on-demand into agent context (e.g. AST Code Reviewer, Vector Codebase Memory, Accessibility Auditing).",
    guarantees: "Guarantees: Precise heuristics, low tokens",
  },
  {
    index: "03",
    tone: "amber",
    name: "Hooks",
    discipline: "Lifecycle interceptors",
    description:
      "Event-driven guards invoked before and after agent tool actions (e.g. Auto Test on file edit, Git Conventional Commit linter, Playwright visual snapshot).",
    guarantees: "Guarantees: Immediate failure detection",
  },
];

export default function ArchitecturePrimitives() {
  return (
    <div className="grid grid-cols-1 gap-4 pt-2 md:grid-cols-3">
      {primitives.map((primitive) => {
        const { chip, discipline } = primitiveTone({ tone: primitive.tone });

        return (
          <article
            key={primitive.index}
            className="flex flex-col justify-between rounded-2xl border border-zinc-200/90 bg-card p-5 shadow-xs"
          >
            <div>
              <p className={chip()}>{primitive.index}</p>

              <h3 className="text-base font-semibold">{primitive.name}</h3>

              <p className={discipline()}>{primitive.discipline}</p>

              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {primitive.description}
              </p>
            </div>

            <p className="mt-4 border-t border-zinc-100 pt-3 font-mono text-[11px] text-muted-foreground">
              {primitive.guarantees}
            </p>
          </article>
        );
      })}
    </div>
  );
}
