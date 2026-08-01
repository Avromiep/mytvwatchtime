import { isAnimeSignal } from './anime-signal';

describe('isAnimeSignal', () => {
  it('is true only for TMDB Animation (16) plus the anime keyword', () => {
    expect(isAnimeSignal([16, 10759], ['anime'])).toBe(true);
    expect(isAnimeSignal([16], ['Anime', 'isekai'])).toBe(true);
  });

  it('is false for Animation without the anime keyword', () => {
    expect(isAnimeSignal([16, 35], ['family'])).toBe(false);
    expect(isAnimeSignal([16], [])).toBe(false);
  });

  it('is false for the anime keyword without Animation', () => {
    expect(isAnimeSignal([18, 9648], ['anime'])).toBe(false);
  });

  it('is false for empty inputs', () => {
    expect(isAnimeSignal([], [])).toBe(false);
  });
});
