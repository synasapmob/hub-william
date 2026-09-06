import { groupLabel, type CatalogGroup } from "@/services/catalog";
import { groupSlots } from "@/utils/utils.tone";

import {
  GROUP_HEADING_HEIGHT,
  GROUP_HEADING_WIDTH,
  TREE_SPINE_X,
} from "./catalog-canvas-geometry";

interface CatalogCanvasGroupHeadingProps {
  group: CatalogGroup;
  size: number;
  top: number;
}

/**
 * The name of one folder, astride the spine above its cards.
 *
 * It is drawn as HTML rather than SVG text so it can carry the same border,
 * radius and type scale as everything else on the artboard — and because being
 * opaque is the point: the grey trunk runs behind it, so the line reads as
 * arriving at the group rather than sliding past its label.
 */
export default function CatalogCanvasGroupHeading({
  group,
  size,
  top,
}: CatalogCanvasGroupHeadingProps) {
  const { heading, headingCount, headingLabel } = groupSlots(group);

  return (
    <div
      style={{
        left: `${TREE_SPINE_X - GROUP_HEADING_WIDTH / 2}px`,
        top: `${top}px`,
        width: `${GROUP_HEADING_WIDTH}px`,
        height: `${GROUP_HEADING_HEIGHT}px`,
      }}
      className={heading()}
    >
      <p className={headingLabel()}>{groupLabel(group)}</p>
      <p className={headingCount()}>{size}</p>
    </div>
  );
}
