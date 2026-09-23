import { useEffect, useState, type RefObject } from "react";
import { tv } from "tailwind-variants";

import type { AgentPool } from "@/services/agent-pools";

const link = tv({
  base: "fill-none transition-colors",
  variants: {
    highlighted: { true: "stroke-indigo-500", false: "stroke-zinc-300" },
  },
});

interface AgentsExplorerLinksProps {
  boardRef: RefObject<HTMLDivElement | null>;
  highlightedId: string | null;
  pools: AgentPool[];
}

interface AgentsExplorerLinksPath {
  id: string;
  poolId: string;
  from: string;
  to: string;
  d: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface AgentsExplorerLinksGeometry {
  width: number;
  height: number;
  paths: AgentsExplorerLinksPath[];
}

export default function AgentsExplorerLinks({
  boardRef,
  highlightedId,
  pools,
}: AgentsExplorerLinksProps) {
  const [geometry, setGeometry] = useState<AgentsExplorerLinksGeometry>({
    width: 0,
    height: 0,
    paths: [],
  });
  // Geometry only depends on the node identities; hover never restarts measurement.
  const connections = JSON.stringify(
    pools.map((pool) => ({
      poolId: pool.id,
      from: `provider:${pool.agent}`,
      to: `account:${pool.id}`,
    })),
  );

  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const edges: Pick<AgentsExplorerLinksPath, "poolId" | "from" | "to">[] =
      JSON.parse(connections);
    const providerSources = [
      ...new Set(
        edges
          .filter((edge) => edge.from.startsWith("provider:"))
          .map((edge) => edge.from),
      ),
    ];
    let frame = 0;

    function measure() {
      if (!board) return;
      const bounds = board.getBoundingClientRect();
      const nodes = new Map(
        Array.from(
          board.querySelectorAll<HTMLElement>("[data-agent-node]"),
          (node) => [node.dataset.agentNode, node.getBoundingClientRect()],
        ),
      );
      const paths = edges.flatMap((edge) => {
        const source = nodes.get(edge.from);
        const target = nodes.get(edge.to);
        if (!source?.width || !target?.width) return [];

        const horizontal = target.left >= source.right + 8;
        const providerAbove = edge.from.startsWith("provider:") && !horizontal;
        const startX =
          (horizontal
            ? source.right
            : providerAbove
              ? source.left + source.width / 2
              : source.left) - bounds.left;
        const startY =
          (providerAbove
            ? source.bottom
            : source.top + Math.min(source.height / 2, 44)) - bounds.top;
        const endX = target.left - bounds.left;
        const endY = target.top + Math.min(target.height / 2, 44) - bounds.top;
        const lane =
          (providerSources.indexOf(edge.from) + 1) /
          (providerSources.length + 1);
        const railX =
          Math.min(source.left, target.left) - bounds.left - 6 - 10 * lane;
        const middleX = startX + 8 + (endX - startX - 16) * lane;
        const d = horizontal
          ? `M ${startX} ${startY} H ${middleX} V ${endY} H ${endX}`
          : providerAbove
            ? `M ${startX} ${startY} V ${startY + 12} H ${endX - 6 - 10 * lane} V ${endY} H ${endX}`
            : `M ${startX} ${startY} H ${railX} V ${endY} H ${endX}`;

        return [
          {
            ...edge,
            id: `${edge.from}-${edge.to}`,
            d,
            startX,
            startY,
            endX,
            endY,
          },
        ];
      });
      const next = { width: bounds.width, height: bounds.height, paths };
      setGeometry((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    }

    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    }

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(board);
    board
      .querySelectorAll("[data-agent-node]")
      .forEach((node) => observer?.observe(node));
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    schedule();

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [boardRef, connections]);

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full overflow-visible"
      viewBox={`0 0 ${geometry.width || 1} ${geometry.height || 1}`}
    >
      {[...geometry.paths]
        .sort(
          (a, b) =>
            Number(a.poolId === highlightedId) -
            Number(b.poolId === highlightedId),
        )
        .map((path) => (
          <g
            key={path.id}
            className={link({ highlighted: path.poolId === highlightedId })}
          >
            <path
              d={path.d}
              strokeWidth="1.5"
              strokeDasharray="4 5"
              data-agent-link-from={path.from}
              data-agent-link-to={path.to}
            />

            <circle
              cx={path.startX}
              cy={path.startY}
              r="3"
              strokeWidth="1.5"
              className="fill-white"
            />

            <circle
              cx={path.endX}
              cy={path.endY}
              r="3"
              strokeWidth="1.5"
              className="fill-white"
            />
          </g>
        ))}
    </svg>
  );
}
