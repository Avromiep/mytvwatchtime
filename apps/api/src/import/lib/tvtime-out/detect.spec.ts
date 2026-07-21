import {
  classifyTvTimeOutFile,
  isTvTimeOutArchive,
  isTvTimeOutStandaloneFile,
} from './detect';
import { isTraktArchive } from '../trakt/detect';
import { isTvTimeJsonArchive } from '../tvtime-json/detect';

describe('tvtime-out detect', () => {
  it('classifies the dated export files by basename', () => {
    expect(classifyTvTimeOutFile('tvtime-series-2026-07-15.json')).toBe('series');
    expect(classifyTvTimeOutFile('tvtime-movies-2026-07-15.json')).toBe('movies');
    expect(classifyTvTimeOutFile('tvtime-failed-2026-07-15.json')).toBe('failed');
    expect(classifyTvTimeOutFile('tvtime-summary-2026-07-15.html')).toBe('summary');
  });

  it('handles subfolders and case-insensitivity', () => {
    expect(classifyTvTimeOutFile('TV Time Out/TvTime-Series-2026-07-15.JSON')).toBe('series');
    expect(classifyTvTimeOutFile('data\\tvtime-movies-2026-01-01.json')).toBe('movies');
  });

  it('returns unsupported for unknown or malformed files', () => {
    expect(classifyTvTimeOutFile('tvtime.json')).toBe('unsupported');
    expect(classifyTvTimeOutFile('tvtime-series.json')).toBe('unsupported');
    expect(classifyTvTimeOutFile('shows.json')).toBe('unsupported');
    expect(classifyTvTimeOutFile('readme.txt')).toBe('unsupported');
  });

  it('detects the archive via any marker file', () => {
    expect(isTvTimeOutArchive(['tvtime-series-2026-07-15.json', 'tvtime-movies-2026-07-15.json'])).toBe(true);
    expect(isTvTimeOutArchive(['tvtime-failed-2026-07-15.json'])).toBe(true);
    expect(isTvTimeOutArchive(['nested/dir/tvtime-movies-2026-07-15.json'])).toBe(true);
    expect(isTvTimeOutArchive(['shows.json', 'movies.json'])).toBe(false);
    expect(isTvTimeOutArchive(['watched-history-1.json'])).toBe(false);
  });

  it('accepts standalone single-file JSON uploads (series/movies only)', () => {
    expect(isTvTimeOutStandaloneFile('tvtime-series-2026-07-15.json')).toBe(true);
    expect(isTvTimeOutStandaloneFile('TvTime-Movies-2026-07-15.JSON')).toBe(true);
    expect(isTvTimeOutStandaloneFile('tvtime-failed-2026-07-15.json')).toBe(false);
    expect(isTvTimeOutStandaloneFile('tvtime-summary-2026-07-15.html')).toBe(false);
  });

  it('does not overlap with Trakt or tvtime-json detection in any direction', () => {
    const tvTimeOut = [
      'tvtime-series-2026-07-15.json',
      'tvtime-movies-2026-07-15.json',
      'tvtime-failed-2026-07-15.json',
      'tvtime-summary-2026-07-15.html',
    ];
    expect(isTraktArchive(tvTimeOut)).toBe(false);
    expect(isTvTimeJsonArchive(tvTimeOut)).toBe(false);
    expect(isTvTimeOutArchive(['watched-history-1.json', 'ratings-shows.json'])).toBe(false);
    expect(isTvTimeOutArchive(['shows.json', 'movies.json', 'activity_history.csv'])).toBe(false);
  });
});
