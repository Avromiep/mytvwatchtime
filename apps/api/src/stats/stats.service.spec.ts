import { topGenresByDistinctTitles } from './stats.service';

describe('topGenresByDistinctTitles', () => {
  it('counts genres once per title instead of once per episode or rewatch', () => {
    const show = {
      mediaId: 'show-1',
      media: {
        genres: [{ genre: { name: 'Drama' } }, { genre: { name: 'Comedy' } }],
      },
    };

    expect(
      topGenresByDistinctTitles([
        show,
        show,
        show,
        {
          mediaId: 'show-2',
          media: { genres: [{ genre: { name: 'Drama' } }] },
        },
      ]),
    ).toEqual([
      { name: 'Drama', count: 2 },
      { name: 'Comedy', count: 1 },
    ]);
  });
});
