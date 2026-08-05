export const LIST_COLLECTION_QUERY_PREFIXES = [
  'myLists',
  'lists',
  'userLists',
  'followedLists',
] as const;

export function removeListFromCollection(data: unknown, listId: string): unknown {
  if (!Array.isArray(data)) return data;
  return data.filter((list: any) => list?.id !== listId);
}
