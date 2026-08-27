export const TIMELINE_PAGE_SIZE = 30;
export const COLLECTION_PAGE_SIZE = 12;

export function buildCollectionWindow(items, limit = COLLECTION_PAGE_SIZE) {
  const safeItems = Array.isArray(items) ? items : [];
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : COLLECTION_PAGE_SIZE;
  const shown = Math.min(safeLimit, safeItems.length);

  return {
    items: safeItems.slice(0, shown),
    total: safeItems.length,
    shown,
    remaining: safeItems.length - shown,
    nextLimit: Math.min(safeItems.length, shown + COLLECTION_PAGE_SIZE)
  };
}

export function buildTimelineWindow(crumbs, projectId, limit = TIMELINE_PAGE_SIZE) {
  const safeCrumbs = Array.isArray(crumbs) ? crumbs : [];
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : TIMELINE_PAGE_SIZE;
  const ordered = safeCrumbs
    .map((crumb, index) => ({ crumb, index }))
    .filter(({ crumb }) => crumb?.projectId === projectId)
    .sort((left, right) => {
      const leftTime = sortableTime(left.crumb?.createdAt);
      const rightTime = sortableTime(right.crumb?.createdAt);
      const timeDifference = rightTime - leftTime;
      if (timeDifference) return timeDifference;
      return Number.isFinite(leftTime) && Number.isFinite(rightTime)
        ? right.index - left.index
        : left.index - right.index;
    })
    .map(({ crumb }) => crumb);
  const shown = Math.min(safeLimit, ordered.length);

  return {
    items: ordered.slice(0, shown),
    total: ordered.length,
    shown,
    remaining: ordered.length - shown,
    nextLimit: Math.min(ordered.length, shown + TIMELINE_PAGE_SIZE)
  };
}

function sortableTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
