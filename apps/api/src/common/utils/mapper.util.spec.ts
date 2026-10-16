import { MediaType } from '@tvwatch/shared';
import { mapMediaCardLite } from './mapper.util';

describe('mapMediaCardLite', () => {
  it('returns releaseDate (ISO) for a movie card', () => {
    const dto = mapMediaCardLite({
      id: 'm1',
      type: MediaType.MOVIE,
      title: 'Test Movie',
      rating: 7.5,
      movie: { releaseYear: 2026, releaseDate: new Date('2026-09-09T00:00:00.000Z') },
    });
    expect(dto.type).toBe(MediaType.MOVIE);
    expect(dto.year).toBe(2026);
    expect(dto.releaseDate).toBe('2026-09-09T00:00:00.000Z');
  });

  it('returns null releaseDate when the movie has none', () => {
    const dto = mapMediaCardLite({
      id: 'm2',
      type: MediaType.MOVIE,
      title: 'No Date',
      movie: { releaseYear: 2027, releaseDate: null },
    });
    expect(dto.releaseDate).toBeNull();
  });

  it('does not set a releaseDate for shows', () => {
    const dto = mapMediaCardLite({
      id: 's1',
      type: MediaType.SHOW,
      title: 'Test Show',
      show: { yearStart: 2020, episodesCount: 10 },
    });
    expect(dto.releaseDate).toBeNull();
    expect(dto.year).toBe(2020);
  });
});
