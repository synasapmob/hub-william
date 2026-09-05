import type { CatalogCategory } from "@/services/catalog";
import { areaTone } from "@/styles/library/library-index";

import {
  categoryTrunkPort,
  entrySocketX,
  GROUP_HEADING_HEIGHT,
  TREE_SPINE_X,
  TRUNK_ELBOW_Y,
  type TreeGroup,
} from "./canvas-geometry";

interface TreeBranchesProps {
  category: CatalogCategory;
  groups: TreeGroup[];
}

/**
 * The wiring under an open root: one neutral trunk, one coloured block per
 * integration.
 *
 * The trunk is deliberately grey. It is the only line that is not about an
 * integration, and colouring it too would leave one more hue in a picture whose
 * whole job is to say "these groups are different things". It runs the full
 * height behind the heading blocks, which are opaque and sit above it, so each
 * heading reads as something the line passes into rather than beside.
 */
export default function TreeBranches({ category, groups }: TreeBranchesProps) {
  const trunkPort = categoryTrunkPort(category);
  const lastGroup = groups.at(-1);
  const spineEnd = lastGroup?.rows.at(-1)?.barY;

  if (spineEnd === undefined) return null;

  return (
    <g>
      {/* Down out of the open root, across to the spine, then down the spine. */}
      <g className="stroke-slate-300">
        <line
          x1={trunkPort.x}
          y1={trunkPort.y}
          x2={trunkPort.x}
          y2={TRUNK_ELBOW_Y}
          strokeWidth={3}
        />
        <line
          x1={trunkPort.x}
          y1={TRUNK_ELBOW_Y}
          x2={TREE_SPINE_X}
          y2={TRUNK_ELBOW_Y}
          strokeWidth={3}
        />
        <line
          x1={TREE_SPINE_X}
          y1={TRUNK_ELBOW_Y}
          x2={TREE_SPINE_X}
          y2={spineEnd}
          strokeWidth={3}
        />
      </g>

      {groups.map((group) => {
        const { branch, node } = areaTone({ area: group.area });
        const headingBottom = group.headingY + GROUP_HEADING_HEIGHT;

        return (
          <g key={group.area}>
            {/* From the heading down into the group's own colour. */}
            <line
              x1={TREE_SPINE_X}
              y1={headingBottom}
              x2={TREE_SPINE_X}
              y2={group.rows.at(-1)?.barY ?? headingBottom}
              strokeWidth={3}
              className={branch()}
            />

            {group.rows.map((row) => {
              const socketXs = row.placed.map((placed) =>
                entrySocketX(placed.position),
              );
              // The bar spans the sockets it feeds and always reaches the spine,
              // so a row holding a single centred card is still a bar.
              const barStart = Math.min(TREE_SPINE_X, ...socketXs);
              const barEnd = Math.max(TREE_SPINE_X, ...socketXs);

              return (
                <g key={row.barY}>
                  <line
                    x1={barStart}
                    y1={row.barY}
                    x2={barEnd}
                    y2={row.barY}
                    strokeWidth={2.5}
                    className={branch()}
                  />
                  <circle
                    cx={TREE_SPINE_X}
                    cy={row.barY}
                    r={4.5}
                    className={node()}
                  />

                  {row.placed.map((placed, index) => {
                    const socketX = socketXs[index];

                    return (
                      <g key={placed.entry.id}>
                        <line
                          x1={socketX}
                          y1={row.barY}
                          x2={socketX}
                          y2={placed.position.y}
                          strokeWidth={placed.isMatch ? 2.5 : 1.5}
                          strokeDasharray={placed.isMatch ? undefined : "4 3"}
                          strokeOpacity={placed.isMatch ? 1 : 0.4}
                          className={branch()}
                        />
                        <circle
                          cx={socketX}
                          cy={placed.position.y}
                          r={4}
                          stroke="white"
                          strokeWidth={1.5}
                          className={node()}
                        />
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </g>
        );
      })}
    </g>
  );
}
