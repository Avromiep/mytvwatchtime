import { countUnwatchedPreviousEpisodes } from '../episode-progress';

const now = new Date('2026-08-05T12:00:00.000Z');

describe('countUnwatchedPreviousEpisodes', () => {
  const seasons = [
    {
      number: 0,
      isSpecial: true,
      episodes: [{ id: 'special', number: 1, watched: false, airDate: '2020-01-01' }],
    },
    {
      number: 1,
      episodes: [
        { id: 's1e1', number: 1, watched: true, airDate: '2025-01-01' },
        { id: 's1e2', number: 2, watched: false, airDate: '2025-01-08' },
      ],
    },
    {
      number: 2,
      episodes: [
        { id: 's2e1', number: 1, watched: false, airDate: '2026-07-01' },
        { id: 's2e2', number: 2, watched: false, airDate: '2026-08-12' },
        { id: 's2e3', number: 3, watched: false, airDate: null },
      ],
    },
  ];

  it('counts unwatched aired episodes in earlier seasons and earlier in the current season', () => {
    expect(countUnwatchedPreviousEpisodes(seasons, 2, 4, now)).toBe(2);
  });

  it('ignores specials, future episodes, unknown air dates, and the selected episode', () => {
    expect(countUnwatchedPreviousEpisodes(seasons, 2, 2, now)).toBe(2);
    expect(countUnwatchedPreviousEpisodes(seasons, 0, 2, now)).toBe(0);
  });
});
