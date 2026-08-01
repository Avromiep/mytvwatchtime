/**
 * Match-time anime signal from TMDB metadata (used by the import matcher before any
 * hydration/classification has happened). Both signals must be authored by TMDB:
 * genre id 16 = Animation and the normalized keyword `anime`.
 */
export function isAnimeSignal(genreIds: number[], keywords: string[]): boolean {
  return (
    genreIds.includes(16) && keywords.some((keyword) => keyword.trim().toLowerCase() === 'anime')
  );
}
