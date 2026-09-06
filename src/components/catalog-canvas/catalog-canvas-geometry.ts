import {
  type CatalogCategory,
  type CatalogEntry,
  type CatalogGroup,
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
 * One folder's whole block: a heading on the spine, then its cards.
 *
 * The heading is what makes the tree legible — a reader can see that these four
 * tags are the GitHub ones without reading four cards — and it is why a group
 * is a block rather than a run of identically coloured rows. A group wraps onto
 * as many rows as it needs; the heading is stated once, at the top.
 */
export interface TreeGroup {
  group: CatalogGroup;
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
 * The card is given this height rather than measured for it. Guessing at a
 * rendered height is how the trunk ended up leaving from 63 units below the
 * card it was supposed to hang off: the constant said 268 and the card drew
 * 205. Pinning the element to the constant makes the two true by construction,
 * and it is also what keeps every root the same height as the others when one
 * of them carries more folder chips.
 */
export const CATEGORY_CARD_HEIGHT = 205;

const CATEGORY_CARD_GAP = 32;
const CATEGORY_ROW_Y = 120;

const CARDS_PER_ROW = 5;
const ENTRY_CARD_GAP = 28;

/**
 * The spine is a constant, so a canvas with two roots and one with three hang
 * their trees from the same line and neither has to thread a measurement
 * through every component that draws on it. The cap is what buys that: the row
 * is sized for the most roots a section may have, and the roots it does have
 * are centred inside it.
 */
const MAX_ROOTS = 4;

const CATEGORY_ROW_WIDTH =
  MAX_ROOTS * CATEGORY_CARD_WIDTH + (MAX_ROOTS - 1) * CATEGORY_CARD_GAP;

const WIDEST_TREE_ROW =
  CARDS_PER_ROW * ENTRY_CARD_WIDTH + (CARDS_PER_ROW - 1) * ENTRY_CARD_GAP;

/**
 * The artboard is as wide as its widest thing, not as wide as its roots.
 *
 * Deriving this from the root row alone put the tree's left edge at a negative
 * x as soon as a full row of cards was wider than the row of roots — and the
 * branch layer is an SVG anchored at x=0, so everything left of the origin was
 * simply clipped and a group's bar arrived cut in half. Three roots and five
 * cards to a row is exactly that case: 542 − 856 = −314.
 */
const CONTENT_WIDTH = Math.max(CATEGORY_ROW_WIDTH, WIDEST_TREE_ROW);

/**
 * The spine every tree descends, and the axis the roots centre on.
 *
 * The trunk leaves whichever root is open, runs across to this line, and only
 * then goes down. Hanging each tree under its own root instead would push the
 * first tree's cards off the left of the artboard and the last one's off the
 * right, because a full row of cards is wider than a root card.
 */
export const TREE_SPINE_X = CONTENT_WIDTH / 2;

/** The roots sit in one row, centred on the spine the trees hang from. */
export function rootPositions(
  roots: CatalogCategory[],
): Record<CatalogCategory, CanvasPosition> {
  const width =
    roots.length * CATEGORY_CARD_WIDTH + (roots.length - 1) * CATEGORY_CARD_GAP;
  const startX = TREE_SPINE_X - width / 2;

  return Object.fromEntries(
    roots.map((root, index) => [
      root,
      {
        x: startX + index * (CATEGORY_CARD_WIDTH + CATEGORY_CARD_GAP),
        y: CATEGORY_ROW_Y,
      },
    ]),
  );
}

/** Where the trunk turns from vertical to horizontal on its way to the spine. */
export const TRUNK_ELBOW_Y = CATEGORY_ROW_Y + CATEGORY_CARD_HEIGHT + 70;

/**
 * Every entry card is exactly this tall.
 *
 * They used to render 165 or 211 depending on how far the description wrapped,
 * which read as a ragged grid. The value is the tallest a card needed, so
 * pinning it changes nothing about what fits — it only stops the short ones
 * from being short.
 */
export const ENTRY_CARD_HEIGHT = 211;

const TREE_TOP = TRUNK_ELBOW_Y + 70;
/** Heading bottom to the first bar, and bar to the cards it feeds. */
const HEADING_TO_BAR = 52;
const BAR_TO_CARDS = 44;
/** Between two wrapped rows of one group, and between two groups. */
const ROW_GAP = 46;
const GROUP_GAP = 96;

export function categoryTrunkPort(position: CanvasPosition): CanvasPosition {
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
 * The order is the caller's, not this function's: the service decides it once
 * so the canvas, the root card's chip row and anything else counting groups all
 * agree. Layout only walks that order and turns it into positions.
 */
export function treeGroups(
  entries: CatalogEntry[],
  order: CatalogGroup[],
  isMatch: (entry: CatalogEntry) => boolean,
): TreeGroup[] {
  const groups: TreeGroup[] = [];
  let cursor = TREE_TOP;

  for (const group of order) {
    const inGroup = entries.filter((entry) => entry.group === group);

    if (inGroup.length === 0) continue;

    const headingY = cursor;
    const rows: TreeRow[] = [];
    let rowTop = headingY + GROUP_HEADING_HEIGHT + HEADING_TO_BAR;

    for (const rowEntries of chunk(inGroup, CARDS_PER_ROW)) {
      const rowWidth =
        rowEntries.length * ENTRY_CARD_WIDTH +
        (rowEntries.length - 1) * ENTRY_CARD_GAP;
      const startX = TREE_SPINE_X - rowWidth / 2;
      const cardsY = rowTop + BAR_TO_CARDS;

      rows.push({
        barY: rowTop,
        placed: rowEntries.map((entry, index) => ({
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

    groups.push({ group, headingY, size: inGroup.length, rows });
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
 * Every root is always in frame — they are how the reader switches trees — so
 * the box starts from them and grows to whichever tree is open.
 */
export function drawnBounds(
  groups: TreeGroup[],
  positions: Record<CatalogCategory, CanvasPosition>,
): CanvasBounds {
  const roots = Object.values(positions);
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
