import { serializeQueryClient } from '../query-persistence';

describe('serializeQueryClient', () => {
  it('truncates only the persisted copy of paged collections', () => {
    const data = {
      pages: [{ page: 1 }, { page: 2 }, { page: 3 }, { page: 4 }],
      pageParams: [1, 2, 3, 4],
    };
    const client = {
      timestamp: 1,
      buster: 'v2',
      clientState: {
        mutations: [],
        queries: [
          {
            queryKey: ['movies', 'watched', 'paged', 24],
            state: { status: 'success', data },
          },
        ],
      },
    };

    const serialized = JSON.parse(serializeQueryClient(client));

    expect(serialized.clientState.queries[0].state.data.pages).toHaveLength(2);
    expect(serialized.clientState.queries[0].state.data.pageParams).toEqual([1, 2]);
    expect(data.pages.map((page) => page.page)).toEqual([1, 2, 3, 4]);
    expect(data.pageParams).toEqual([1, 2, 3, 4]);
  });

  it('does not truncate unrelated infinite queries', () => {
    const client = {
      clientState: {
        queries: [
          {
            queryKey: ['search', 'paged'],
            state: {
              data: { pages: [{ page: 1 }, { page: 2 }, { page: 3 }], pageParams: [1, 2, 3] },
            },
          },
        ],
      },
    };

    const serialized = JSON.parse(serializeQueryClient(client));
    expect(serialized.clientState.queries[0].state.data.pages).toHaveLength(3);
  });
});
