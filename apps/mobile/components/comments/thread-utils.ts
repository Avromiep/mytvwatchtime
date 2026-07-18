import type { CommentDto } from '@tvwatch/shared';

/**
 * Helpers for the Reddit-style threaded comment screen.
 *
 * The server returns thread pages as a FLAT list (direct children of the requested
 * comment, optionally followed by each direct child's first children — depth=2).
 * These helpers merge that with locally expanded subtrees ("Show more replies")
 * and flatten the visible tree into rows for a single FlatList.
 */

/** One row in the flattened thread list. */
export type ThreadRow =
  | { type: 'comment'; comment: CommentDto; depth: number }
  | {
      type: 'more';
      parentId: string;
      depth: number;
      remaining: number;
      /** True after the parent was already inline-expanded: deeper navigation instead of another inline load. */
      continueThread: boolean;
    };

/** Locally fetched subtree of one node ("Show more replies" result). */
export interface ExpandedNode {
  items: CommentDto[];
  loading: boolean;
}

/** Visual indent cap — deeper levels render at the same offset (like Reddit). */
export const MAX_VISIBLE_INDENT = 5;

/** Indent in px for a thread depth (1 = direct reply). */
export function threadIndent(depth: number): number {
  return Math.min(Math.max(depth, 0), MAX_VISIBLE_INDENT) * 12;
}

/**
 * Merge the root page items with expanded subtrees (expanded wins per id, first
 * insert keeps its position) and group children by parentId, preserving order.
 * Returns the children map plus a by-id lookup for the whole merged set.
 */
export function buildChildrenMap(
  rootItems: CommentDto[],
  expanded: Record<string, ExpandedNode | undefined>,
) {
  const byId = new Map<string, CommentDto>();
  for (const c of rootItems) byId.set(c.id, c);
  for (const node of Object.values(expanded)) {
    if (!node) continue;
    for (const c of node.items) byId.set(c.id, c);
  }
  const childrenOf = new Map<string, CommentDto[]>();
  for (const c of byId.values()) {
    if (!c.parentId) continue;
    const list = childrenOf.get(c.parentId);
    if (list) list.push(c);
    else childrenOf.set(c.parentId, [c]);
  }
  return { childrenOf, byId };
}

/**
 * Pre-order walk of the visible tree below `rootId`. Children of collapsed nodes
 * are skipped (the node itself stays visible). A `more` row is emitted under a
 * node whose loaded children are fewer than its `repliesCount`.
 *
 * Depth is relative to the screen root: direct replies render at depth 1.
 * No `more` row is emitted for the root itself — its children are paginated by
 * the screen's infinite query instead.
 */
export function flattenThread(
  rootId: string,
  childrenOf: Map<string, CommentDto[]>,
  collapsed: ReadonlySet<string>,
  expanded: Record<string, ExpandedNode | undefined>,
): ThreadRow[] {
  const rows: ThreadRow[] = [];
  const walk = (parentId: string, depth: number) => {
    const kids = childrenOf.get(parentId);
    if (!kids) return;
    for (const kid of kids) {
      rows.push({ type: 'comment', comment: kid, depth });
      if (collapsed.has(kid.id)) continue;
      const childDepth = depth + 1;
      walk(kid.id, childDepth);
      const loaded = childrenOf.get(kid.id)?.length ?? 0;
      const remaining = kid.repliesCount - loaded;
      if (remaining > 0) {
        const node = expanded[kid.id];
        rows.push({
          type: 'more',
          parentId: kid.id,
          depth: childDepth,
          remaining,
          continueThread: !!node && !node.loading,
        });
      }
    }
  };
  walk(rootId, 1);
  return rows;
}
