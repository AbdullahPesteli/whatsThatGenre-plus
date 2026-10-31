/** Gap kept between the genre row and the progress bar, px. */
export const ROW_GAP = 4;

export interface RowPlacementInput {
  /** Offset height of the host: the default `top` (row directly under host). */
  hostHeight: number;
  /** Viewport top of the host. */
  hostTop: number;
  rowHeight: number;
  /** Viewport top of the progress bar (+Infinity when absent). */
  barTop: number;
  /** Viewport bottom of the nearest clipping ancestor (+Infinity when none). */
  clipBottom: number;
}

export interface RowPlacement {
  top: number;
  hidden: boolean;
  action: "keep" | "shifted" | "hidden";
  overlaps: boolean;
}

/**
 * Position first, hide never-by-default: if the row would hit the progress bar
 * (or an overflow clip) it is shifted up (clamped to >= 0). Only when it still
 * collides after shifting is it hidden (last resort -> tooltip fallback).
 */
export function placeRow(i: RowPlacementInput): RowPlacement {
  const defaultBottom = i.hostTop + i.hostHeight + i.rowHeight;
  const barLimit = i.barTop - ROW_GAP;
  const overlaps =
    defaultBottom > barLimit + 0.5 || defaultBottom > i.clipBottom + 0.5;
  if (!overlaps) {
    return { top: i.hostHeight, hidden: false, action: "keep", overlaps };
  }
  const limit = Math.min(barLimit, i.clipBottom);
  const maxTop = limit - i.rowHeight - i.hostTop;
  const top = Math.max(0, Math.min(i.hostHeight, maxTop));
  const stillOverlaps = i.hostTop + top + i.rowHeight > limit + 0.5;
  return stillOverlaps
    ? { top, hidden: true, action: "hidden", overlaps }
    : { top, hidden: false, action: "shifted", overlaps };
}
