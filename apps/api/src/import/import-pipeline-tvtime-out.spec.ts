import * as fs from 'fs';
import * as path from 'path';
import { classifyTvTimeOutFile, isTvTimeOutArchive } from './lib/tvtime-out/detect';
import { normalizeTvTimeOutSeries } from './lib/tvtime-out/series';
import { normalizeTvTimeOutMovies } from './lib/tvtime-out/movies';
import { normalizeTvTimeOutFailed } from './lib/tvtime-out/failed';

const FIXTURE_DIR = path.join(__dirname, '../../test/fixtures/tvtime-out');

function loadAll(): { filename: string; kind: ReturnType<typeof classifyTvTimeOutFile> }[] {
  return fs.readdirSync(FIXTURE_DIR).map((filename) => ({ filename, kind: classifyTvTimeOutFile(filename) }));
}

function loadJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

describe('tvtime-out import pipeline (fixtures, no DB)', () => {
  it('detects the archive and classifies every fixture file', () => {
    const files = loadAll();
    expect(isTvTimeOutArchive(files.map((f) => f.filename))).toBe(true);
    const byKind = new Map(files.map((f) => [f.filename, f.kind]));
    expect(byKind.get('tvtime-series-2026-07-15.json')).toBe('series');
    expect(byKind.get('tvtime-movies-2026-07-15.json')).toBe('movies');
    expect(byKind.get('tvtime-failed-2026-07-15.json')).toBe('failed');
    expect(byKind.get('tvtime-summary-2026-07-15.html')).toBe('summary');
  });

  it('normalizes watched episodes with specials flagged, rewatch counts, and a non-special footprint', () => {
    const res = normalizeTvTimeOutSeries(loadJson('tvtime-series-2026-07-15.json'));
    expect(res.invalid).toBe(0);
    expect(res.episodes).toHaveLength(4); // 2 regular + s1 special E9 + s0 special; unwatched S1E3 excluded
    expect(res.episodes.filter((e) => e.special)).toHaveLength(2);
    expect(res.episodes.find((e) => e.episode === 2)!.watchCount).toBe(3); // rewatch_count 2 + 1
    expect(res.episodes.find((e) => e.episode === 9)!.watchCount).toBe(4); // watched_count 4 wins
    const fp = res.footprints.get('tvdb:427464')!;
    expect(fp.seasonEpisodes).toEqual([{ season: 1, maxEpisode: 3 }]); // special E9 + specials season excluded
  });

  it('puts fully-unwatched shows on the watchlist and favorites independently', () => {
    const res = normalizeTvTimeOutSeries(loadJson('tvtime-series-2026-07-15.json'));
    expect(res.watchlist).toHaveLength(1);
    expect(res.watchlist[0]).toMatchObject({ type: 'show', title: 'The Bear' });
    expect(res.favorites).toHaveLength(1);
    expect(res.favorites[0]).toMatchObject({ type: 'show', title: 'The Bear' });
  });

  it('splits movies into watched and watchlist with favorites and rewatch counts', () => {
    const res = normalizeTvTimeOutMovies(loadJson('tvtime-movies-2026-07-15.json'));
    expect(res.watched).toHaveLength(1);
    expect(res.watched[0]).toMatchObject({
      movieTitle: 'Ant-Man and the Wasp: Quantumania',
      year: 2023,
      watchCount: 2, // rewatch_count 1 + 1
    });
    expect(res.watchlist).toHaveLength(1);
    expect(res.watchlist[0].title).toBe('Fantasy Football ruined our lives');
    expect(res.favorites).toHaveLength(1);
    expect(res.favorites[0].title).toBe('Ant-Man and the Wasp: Quantumania');
  });

  it('parses the failed-shows report for logging (never staged)', () => {
    const res = normalizeTvTimeOutFailed(loadJson('tvtime-failed-2026-07-15.json'));
    expect(res.total).toBe(1);
    expect(res.shows).toEqual([{ title: 'Alphas', tvdbId: 210841 }]);
  });
});
