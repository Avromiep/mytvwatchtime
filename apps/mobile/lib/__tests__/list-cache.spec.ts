import { LIST_COLLECTION_QUERY_PREFIXES, removeListFromCollection } from '../list-cache';

describe('list cache helpers', () => {
  it('includes the profile list query in deletion updates', () => {
    expect(LIST_COLLECTION_QUERY_PREFIXES).toContain('myLists');
  });

  it('removes the deleted list without mutating the cached array', () => {
    const cached = [{ id: 'keep' }, { id: 'delete' }];

    expect(removeListFromCollection(cached, 'delete')).toEqual([{ id: 'keep' }]);
    expect(cached).toHaveLength(2);
  });
});
