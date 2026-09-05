import {
  AREA_ORDER,
  CATEGORY_ORDER,
  type CatalogArea,
  type CatalogCategory,
  type CatalogEntry,
} from "@/services/catalog";

export interface CanvasPosition {
  x: number;
  y: number;
}

/** An entry once the canvas has decided where it sits and whether search kept it. */
export interface PlacedEntry {
  entry: CatalogEntry;
  position: CanvasPosition;
  isMatch: boolean;
}

/** One drawn row of cards: a coloured bar and the cards hanging off it. */
export interface TreeRow {
  barY: number;
  placed: PlacedEntry[];
}

/**
 * One integration's whole block: a heading on the spine, then its cards.
 *
 * The heading is what makes the tree legible — a reader can see that these four
 * tags are the GitHub ones without reading four cards — and it is why an area
 * is a block rather than a run of identically coloured rows. A group wraps onto
 * as many rows as it needs; the heading is stated once, at the top.
 */
export interface TreeGroup {
  area: CatalogArea;
  headingY: number;
  size: number;
  rows: TreeRow[];
}

export const CANVAS_WORLD = { width: 3200, height: 4200 } as const;

export const CATEGORY_CARD_WIDTH = 340;
export const ENTRY_CARD_WIDTH = 320;
/** The heading block that sits astride the spine above each group. */
export const GROUP_HEADING_WIDTH = 260;
export const GROUP_HEADING_HEIGHT = 58;

/**
 * A root card's own height, and where its downward trunk leaves it.
 *
 * This has to track what the card actually renders: an offset measured against
 * a shorter card puts the trunk inside the card body. The port itself is placed
 * by CSS on the card, so a unit or two of slack disappears under it.
 */
const CATEGORY_CARD_HEIGHT = 268;

const CATEGORY_CARD_GAP = 32;
const CATEGORY_ROW_Y = 120;

/** The four roots sit in one row, and every tree hangs from the middle of it. */
export const categoryPositions: Record<CatalogCategory, CanvasPosition> =
  Object.fromEntries(
    CATEGORY_ORDER.map((category, index) => [
      category,
      {
        x: index * (CATEGORY_CARD_WIDTH + CATEGORY_CARD_GAP),
        y: CATEGORY_ROW_Y,
      },
    ]),
  ) as Record<CatalogCategory, CanvasPosition>;

const CATEGORY_ROW_WIDTH =
  CATEGORY_ORDER.length * CATEGORY_CARD_WIDTH +
  (CATEGORY_ORDER.length - 1) * CATEGORY_CARD_GAP;

/**
 * The spine every tree descends, centred under the row of roots.
 *
 * The trunk leaves whichever root is open, runs across to this line, and only
 * then goes down. Hanging each tree under its own root instead would push the
 * first tree's cards off the left of the artboard and the last one's off the
 * right, because a row of four cards is wider than a root card.
 */
export const TREE_SPINE_X = CATEGORY_ROW_WIDTH / 2;

/** Where the trunk turns from vertical to horizontal on its way to the spine. */
export const TRUNK_ELBOW_Y = CATEGORY_ROW_Y + CATEGORY_CARD_HEIGHT + 70;

const CARDS_PER_ROW = 4;
const ENTRY_CARD_GAP = 28;
// Entry cards render 176–223 units depending on how far the description wraps.
// The tallest is the one "fit view" has to clear, so this is the tallest.
const ENTRY_CARD_HEIGHT = 223;

const TREE_TOP = TRUNK_ELBOW_Y + 70;
/** Heading bottom to the first bar, and bar to the cards it feeds. */
const HEADING_TO_BAR = 52;
const BAR_TO_CARDS = 44;
/** Between two wrapped rows of one group, and between two groups. */
const ROW_GAP = 46;
const GROUP_GAP = 96;

export function categoryTrunkPort(category: CatalogCategory): CanvasPosition {
  const position = categoryPositions[category];

  return {
    x: position.x + CATEGORY_CARD_WIDTH / 2,
    y: position.y + CATEGORY_CARD_HEIGHT,
  };
}

/** Where an entry card's inbound branch lands: the middle of its top edge. */
export function entrySocketX(position: CanvasPosition) {
  return position.x + ENTRY_CARD_WIDTH / 2;
}

function chunk<Item>(items: Item[], size: number): Item[][] {
  const chunks: Item[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

/**
 * One category's entries, as a stack of headed groups.
 *
 * Areas run in a fixed order rather than by size, so the same group is always
 * in the same place: a reader who learned that Linear sits under GitHub should
 * not have to re-learn it because a contract was added.
 */
export function treeGroups(
  entries: CatalogEntry[],
  isMatch: (entry: CatalogEntry) => boolean,
): TreeGroup[] {
  const groups: TreeGroup[] = [];
  let cursor = TREE_TOP;

  for (const area of AREA_ORDER) {
    const inArea = entries.filter((entry) => entry.area === area);

    if (inArea.length === 0) continue;

    const headingY = cursor;
    const rows: TreeRow[] = [];
    let rowTop = headingY + GROUP_HEADING_HEIGHT + HEADING_TO_BAR;

    for (const group of chunk(inArea, CARDS_PER_ROW)) {
      const rowWidth =
        group.length * ENTRY_CARD_WIDTH + (group.length - 1) * ENTRY_CARD_GAP;
      const startX = TREE_SPINE_X - rowWidth / 2;
      const cardsY = rowTop + BAR_TO_CARDS;

      rows.push({
        barY: rowTop,
        placed: group.map((entry, index) => ({
          entry,
          isMatch: isMatch(entry),
          position: {
            x: startX + index * (ENTRY_CARD_WIDTH + ENTRY_CARD_GAP),
            y: cardsY,
          },
        })),
      });

      rowTop = cardsY + ENTRY_CARD_HEIGHT + ROW_GAP;
    }

    groups.push({ area, headingY, size: inArea.length, rows });
    cursor = rowTop - ROW_GAP + GROUP_GAP;
  }

  return groups;
}

export interface CanvasBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Everything currently drawn, in canvas units.
 *
 * All four roots are always in frame — they are how the reader switches trees —
 * so the box starts from them and grows to whichever tree is open.
 */
export function drawnBounds(groups: TreeGroup[]): CanvasBounds {
  const roots = Object.values(categoryPositions);
  const bounds: CanvasBounds = {
    minX: Math.min(...roots.map((root) => root.x)),
    minY: Math.min(...roots.map((root) => root.y)),
    maxX: Math.max(...roots.map((root) => root.x + CATEGORY_CARD_WIDTH)),
    maxY: Math.max(...roots.map((root) => root.y + CATEGORY_CARD_HEIGHT)),
  };

  for (const group of groups) {
    for (const row of group.rows) {
      for (const { position } of row.placed) {
        bounds.minX = Math.min(bounds.minX, position.x);
        bounds.minY = Math.min(bounds.minY, position.y);
        bounds.maxX = Math.max(bounds.maxX, position.x + ENTRY_CARD_WIDTH);
        bounds.maxY = Math.max(bounds.maxY, position.y + ENTRY_CARD_HEIGHT);
      }
    }
  }

  return bounds;
}
