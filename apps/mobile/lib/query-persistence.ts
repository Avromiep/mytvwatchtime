const MAX_PERSISTED_COLLECTION_PAGES = 2;

type PersistedQuery = {
  queryKey: readonly unknown[];
  state?: {
    data?: unknown;
  };
};

type PersistedClient = {
  clientState: {
    queries: PersistedQuery[];
  };
};

function isPagedCollection(key: readonly unknown[]): boolean {
  return (
    ((key[0] === 'watchlist' || key[0] === 'favorites') && key[1] === 'paged') ||
    (key[0] === 'movies' && key[1] === 'watched' && key[2] === 'paged')
  );
}

/**
 * Keep persisted collection snapshots small without mutating React Query's live
 * InfiniteData object. Dehydrated data can still share nested references with
 * the active cache, so in-place truncation makes freshly appended pages vanish.
 */
export function serializeQueryClient(client: PersistedClient): string {
  const queries = client.clientState.queries.map((query) => {
    const data = query.state?.data as
      { pages?: unknown[]; pageParams?: unknown[]; [key: string]: unknown } | undefined;
    if (
      !isPagedCollection(query.queryKey) ||
      !Array.isArray(data?.pages) ||
      data.pages.length <= MAX_PERSISTED_COLLECTION_PAGES
    ) {
      return query;
    }

    return {
      ...query,
      state: {
        ...query.state,
        data: {
          ...data,
          pages: data.pages.slice(0, MAX_PERSISTED_COLLECTION_PAGES),
          pageParams: Array.isArray(data.pageParams)
            ? data.pageParams.slice(0, MAX_PERSISTED_COLLECTION_PAGES)
            : data.pageParams,
        },
      },
    };
  });

  return JSON.stringify({
    ...client,
    clientState: { ...client.clientState, queries },
  });
}
