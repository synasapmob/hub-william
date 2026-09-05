import { AREA_LABELS, type CatalogArea } from "@/services/catalog";
import { areaTone } from "@/styles/library/library-index";

import {
  GROUP_HEADING_HEIGHT,
  GROUP_HEADING_WIDTH,
  TREE_SPINE_X,
} from "./canvas-geometry";

interface GroupHeadingProps {
  area: CatalogArea;
  size: number;
  top: number;
}

/**
 * The name of one integration, astride the spine above its cards.
 *
 * It is drawn as HTML rather than SVG text so it can carry the same border,
 * radius and type scale as everything else on the artboard — and because being
 * opaque is the point: the grey trunk runs behind it, so the line reads as
 * arriving at the group rather than sliding past its label.
 */
export default function GroupHeading({ area, size, top }: GroupHeadingProps) {
  const { heading, headingCount, headingLabel } = areaTone({ area });

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
      <p className={headingLabel()}>{AREA_LABELS[area]}</p>
      <p className={headingCount()}>{size}</p>
    </div>
  );
}
