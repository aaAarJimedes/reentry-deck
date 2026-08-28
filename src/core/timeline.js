export const TIMELINE_PAGE_SIZE = 30;
export const COLLECTION_PAGE_SIZE = 12;

export function buildCollectionWindow(items, limit = COLLECTION_PAGE_SIZE, knownTotal = undefined) {
  const safeItems = Array.isArray(items) ? items : [];
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : COLLECTION_PAGE_SIZE;
  const shown = Math.min(safeLimit, safeItems.length);
  const total = Number.isSafeInteger(knownTotal) && knownTotal >= shown ? knownTotal : safeItems.length;

  return {
    items: safeItems.slice(0, shown),
    total,
    shown,
    remaining: total - shown,
    nextLimit: Math.min(total, shown + COLLECTION_PAGE_SIZE)
  };
}

export function buildProjectCollectionWindow(projects, scope, limit = COLLECTION_PAGE_SIZE) {
  const safeProjects = Array.isArray(projects) ? projects : [];
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : COLLECTION_PAGE_SIZE;
  if (scope !== "home" && scope !== "archive") {
    return { items: [], total: 0, shown: 0, remaining: 0, nextLimit: 0 };
  }
  const items = [];
  let total = 0;
  for (const project of safeProjects) {
    const matches = scope === "archive" ? project?.status === "archived" : project?.status !== "archived";
    if (!matches) continue;
    total += 1;
    if (items.length < safeLimit) items.push(project);
  }
  const shown = items.length;
  return {
    items,
    total,
    shown,
    remaining: total - shown,
    nextLimit: Math.min(total, shown + COLLECTION_PAGE_SIZE)
  };
}

export function buildTimelineWindow(crumbs, projectId, limit = TIMELINE_PAGE_SIZE) {
  const safeCrumbs = Array.isArray(crumbs) ? crumbs : [];
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : TIMELINE_PAGE_SIZE;
  const selected = [];
  let total = 0;
  for (let index = 0; index < safeCrumbs.length; index += 1) {
    const crumb = safeCrumbs[index];
    if (crumb?.projectId !== projectId) continue;
    total += 1;
    const time = sortableTime(crumb.createdAt);
    if (selected.length < safeLimit) {
      pushWorstFirst(selected, { crumb, index, time });
    } else if (compareTimelinePosition(time, index, selected[0].time, selected[0].index) < 0) {
      selected[0] = { crumb, index, time };
      sinkWorstFirst(selected, 0);
    }
  }
  const ordered = selected
    .sort((left, right) => compareTimelinePosition(left.time, left.index, right.time, right.index))
    .map(({ crumb }) => crumb);
  const shown = ordered.length;

  return {
    items: ordered,
    total,
    shown,
    remaining: total - shown,
    nextLimit: Math.min(total, shown + TIMELINE_PAGE_SIZE)
  };
}

function compareTimelinePosition(leftTime, leftIndex, rightTime, rightIndex) {
  const timeDifference = rightTime - leftTime;
  if (timeDifference) return timeDifference;
  return Number.isFinite(leftTime) && Number.isFinite(rightTime)
    ? rightIndex - leftIndex
    : leftIndex - rightIndex;
}

function pushWorstFirst(heap, entry) {
  heap.push(entry);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareEntries(heap[index], heap[parent]) <= 0) break;
    const previousParent = heap[parent];
    heap[parent] = heap[index];
    heap[index] = previousParent;
    index = parent;
  }
}

function sinkWorstFirst(heap, startIndex) {
  let index = startIndex;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    let worse = left;
    if (right < heap.length && compareEntries(heap[right], heap[left]) > 0) worse = right;
    if (compareEntries(heap[worse], heap[index]) <= 0) return;
    const previous = heap[index];
    heap[index] = heap[worse];
    heap[worse] = previous;
    index = worse;
  }
}

function compareEntries(left, right) {
  return compareTimelinePosition(left.time, left.index, right.time, right.index);
}

function sortableTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
