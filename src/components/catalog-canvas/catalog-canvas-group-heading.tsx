import {
  groupLabel,
  type CatalogCategory,
  type CatalogGroup,
} from "@/services/catalog";
import { rootSlots } from "@/utils/utils.tone";

import {
  GROUP_HEADING_HEIGHT,
  GROUP_HEADING_WIDTH,
  TREE_SPINE_X,
} from "./catalog-canvas-geometry";

interface CatalogCanvasGroupHeadingProps {
  group: CatalogGroup;
  /** The open tree this heading hangs from, which is where its colour is. */
  root: CatalogCategory;
  size: number;
  top: number;
}

/**
 * The name of one folder, astride the spine above its cards.
 *
 * It is drawn as HTML rather than SVG text so it can carry the same border,
 * radius and type scale as everything else on the artboard — and because being
 * opaque is the point: the trunk runs behind it, so the line reads as arriving
 * at the group rather than sliding past its label.
 *
 * The label is what separates one heading from the next; the colour says which
 * tree they are all on. Every heading under one root is that root's hue, so a
 * folder added by a pull request arrives already matching the tree it landed
 * in rather than introducing a colour of its own.
 */
export default function CatalogCanvasGroupHeading({
  group,
  root,
  size,
  top,
}: CatalogCanvasGroupHeadingProps) {
  const { heading, headingCount, headingLabel } = rootSlots(root);

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
