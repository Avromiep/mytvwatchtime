import {
  buildApplyPayload,
  draftReducer,
  emptyDraft,
  isOnboardingDone,
  needsProgressReview,
  selectionCounts,
} from '../draft';

const meta = (type: 'SHOW' | 'MOVIE') => ({ title: 'Title', poster: null, year: 2020, type });

describe('onboarding draft reducer', () => {
  it('toggle adds a show as CAUGHT_UP in WATCHED mode and removes it on second toggle', () => {
    let d = emptyDraft();
    d = draftReducer(d, { type: 'toggle', id: 's1', mediaType: 'SHOW', mode: 'WATCHED', meta: meta('SHOW') });
    expect(d.shows.s1).toEqual({ action: 'CAUGHT_UP' });
    expect(d.meta.s1.title).toBe('Title');
    d = draftReducer(d, { type: 'toggle', id: 's1', mediaType: 'SHOW', mode: 'WATCHED', meta: meta('SHOW') });
    expect(d.shows.s1).toBeUndefined();
  });

  it('toggle adds shows/movies as WATCHLIST in WATCHLIST mode', () => {
    let d = emptyDraft();
    d = draftReducer(d, { type: 'toggle', id: 's1', mediaType: 'SHOW', mode: 'WATCHLIST', meta: meta('SHOW') });
    d = draftReducer(d, { type: 'toggle', id: 'm1', mediaType: 'MOVIE', mode: 'WATCHLIST', meta: meta('MOVIE') });
    expect(d.shows.s1.action).toBe('WATCHLIST');
    expect(d.movies.m1.action).toBe('WATCHLIST');
  });

  it('selections survive a mode switch and both media types coexist', () => {
    let d = emptyDraft();
    d = draftReducer(d, { type: 'toggle', id: 's1', mediaType: 'SHOW', mode: 'WATCHED', meta: meta('SHOW') });
    d = draftReducer(d, { type: 'toggle', id: 'm1', mediaType: 'MOVIE', mode: 'WATCHLIST', meta: meta('MOVIE') });
    expect(selectionCounts(d)).toEqual({
      showsWatched: 1,
      showsWatchlisted: 0,
      moviesWatched: 0,
      moviesWatchlisted: 1,
      total: 2,
    });
  });

  it('setShowAction clears a stale watched-through boundary', () => {
    let d = emptyDraft();
    d = draftReducer(d, { type: 'toggle', id: 's1', mediaType: 'SHOW', mode: 'WATCHED', meta: meta('SHOW') });
    d = draftReducer(d, { type: 'setThrough', id: 's1', seasonNumber: 2, episodeNumber: 5, label: 'S2 E5' });
    expect(d.shows.s1).toEqual({
      action: 'WATCHED_THROUGH',
      throughSeasonNumber: 2,
      throughEpisodeNumber: 5,
      throughLabel: 'S2 E5',
    });
    d = draftReducer(d, { type: 'setShowAction', id: 's1', action: 'CAUGHT_UP' });
    expect(d.shows.s1).toEqual({ action: 'CAUGHT_UP' });
  });

  it('setShowAction / setThrough are no-ops for unselected shows', () => {
    const d = emptyDraft();
    expect(draftReducer(d, { type: 'setShowAction', id: 'x', action: 'CAUGHT_UP' })).toBe(d);
    expect(draftReducer(d, { type: 'setThrough', id: 'x', seasonNumber: 1, episodeNumber: 1, label: 'S1 E1' })).toBe(d);
  });

  it('remove deletes the entry without touching meta', () => {
    let d = emptyDraft();
    d = draftReducer(d, { type: 'toggle', id: 'm1', mediaType: 'MOVIE', mode: 'WATCHED', meta: meta('MOVIE') });
    d = draftReducer(d, { type: 'remove', id: 'm1', mediaType: 'MOVIE' });
    expect(d.movies.m1).toBeUndefined();
    expect(d.meta.m1).toBeDefined();
  });

  it('clear resets the draft; hydrate replaces it', () => {
    let d = emptyDraft();
    d = draftReducer(d, { type: 'toggle', id: 's1', mediaType: 'SHOW', mode: 'WATCHED', meta: meta('SHOW') });
    expect(draftReducer(d, { type: 'clear' })).toEqual(emptyDraft());
    expect(draftReducer(emptyDraft(), { type: 'hydrate', draft: d })).toBe(d);
  });
});

describe('payload + progress helpers', () => {
  it('buildApplyPayload maps the draft to the API contract', () => {
    let d = emptyDraft();
    d = draftReducer(d, { type: 'toggle', id: 's1', mediaType: 'SHOW', mode: 'WATCHED', meta: meta('SHOW') });
    d = draftReducer(d, { type: 'setThrough', id: 's1', seasonNumber: 1, episodeNumber: 8, label: 'S1 E8' });
    d = draftReducer(d, { type: 'toggle', id: 's2', mediaType: 'SHOW', mode: 'WATCHLIST', meta: meta('SHOW') });
    d = draftReducer(d, { type: 'toggle', id: 'm1', mediaType: 'MOVIE', mode: 'WATCHED', meta: meta('MOVIE') });
    expect(buildApplyPayload(d)).toEqual({
      shows: [
        { mediaId: 's1', action: 'WATCHED_THROUGH', throughSeasonNumber: 1, throughEpisodeNumber: 8 },
        { mediaId: 's2', action: 'WATCHLIST' },
      ],
      movies: [{ mediaId: 'm1', action: 'WATCHED' }],
    });
  });

  it('needsProgressReview only when a show is in a watched action', () => {
    let d = emptyDraft();
    d = draftReducer(d, { type: 'toggle', id: 's1', mediaType: 'SHOW', mode: 'WATCHLIST', meta: meta('SHOW') });
    expect(needsProgressReview(d)).toBe(false);
    d = draftReducer(d, { type: 'setShowAction', id: 's1', action: 'CAUGHT_UP' });
    expect(needsProgressReview(d)).toBe(true);
  });
});

describe('isOnboardingDone', () => {
  it('is done only for terminal states at the current version', () => {
    expect(isOnboardingDone('COMPLETED', 1)).toBe(true);
    expect(isOnboardingDone('SKIPPED', 1)).toBe(true);
    expect(isOnboardingDone('COMPLETED', 0)).toBe(false); // older version re-shows
    expect(isOnboardingDone('IN_PROGRESS', 1)).toBe(false);
    expect(isOnboardingDone('NOT_STARTED', null)).toBe(false);
    expect(isOnboardingDone(undefined, undefined)).toBe(false);
  });
});
