import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import { CandidateDetectorService } from './candidate-detector.service';
import { ClassifierService } from './classifier.service';

const detector = new CandidateDetectorService();
const classifier = new ClassifierService();

const animeId = (provider: ExternalProvider) => ({
  provider,
  providerEntityKind: ProviderEntityKind.ANIME,
  value: '1',
});

describe('CandidateDetectorService', () => {
  it('flags a TMDB Animation genre as a candidate', () => {
    const r = detector.detect({ genres: ['Animation', 'Comedy'] });
    expect(r.isCandidate).toBe(true);
    expect(r.signals).toContain('animation_genre');
  });

  it('flags a verified MAL anime id even with missing genres', () => {
    const r = detector.detect({ externalIds: [animeId(ExternalProvider.MYANIME_LIST)] });
    expect(r.isCandidate).toBe(true);
    expect(r.hasVerifiedAnimeId).toBe(true);
  });

  it('flags a TVDB anime type signal', () => {
    const r = detector.detect({ tvdbType: 'Anime' });
    expect(r.isCandidate).toBe(true);
    expect(r.signals).toContain('tvdb_anime_signal');
  });

  it('flags the TMDB `anime` keyword (id 210024) as a candidate', () => {
    const r = detector.detect({ keywords: ['isekai', 'anime', 'magic'] });
    expect(r.isCandidate).toBe(true);
    expect(r.signals).toContain('anime_keyword');
    expect(r.evidence.animeKeyword).toBe(true);
  });

  it('respects a manual candidate override', () => {
    const r = detector.detect({ manualCandidate: true });
    expect(r.isCandidate).toBe(true);
    expect(r.signals).toContain('manual_candidate');
  });

  it('does not flag a non-animated item as candidate (JP origin alone is supporting, not a trigger)', () => {
    const r = detector.detect({
      genres: ['Drama'],
      originalLanguage: 'ja',
      originCountries: ['JP'],
    });
    expect(r.isCandidate).toBe(false);
    expect(r.evidence.japaneseLanguage).toBe(true); // recorded but not a trigger
  });
});

describe('ClassifierService', () => {
  it('confirms ANIME only when TMDB Animation and anime keyword are both present', () => {
    const c = detector.detect({
      genres: ['Animation'],
      tmdbGenreIds: [16],
      keywords: ['anime'],
    });
    const out = classifier.classify(c, null);
    expect(out.classification).toBe('ANIME');
    expect(out.tier).toBe('confirmed');
    expect(out.confidence).toBe(0.95);
  });

  it('keeps Animation without the keyword as GENERAL even with a Kitsu match', () => {
    const c = detector.detect({ genres: ['Animation'], originCountries: ['JP'] });
    const out = classifier.classify(c, {
      matched: true,
      provider: ExternalProvider.KITSU,
      externalId: '9',
      confidence: 0.99,
    });
    expect(out.classification).toBe('GENERAL');
    expect(out.tier).toBe('confirmed');
    expect(out.evidence.enrichmentProvider).toBe(ExternalProvider.KITSU);
  });

  it('keeps the anime keyword without Animation as GENERAL', () => {
    const c = detector.detect({ genres: ['Drama'], keywords: ['anime'] });
    const out = classifier.classify(c, null);
    expect(out.classification).toBe('GENERAL');
    expect(out.tier).toBe('confirmed');
  });

  it('keeps Japanese origin, studio, and verified MAL id as GENERAL without both TMDB signals', () => {
    const c = detector.detect({
      genres: ['Animation'],
      originCountries: ['JP'],
      studios: ['Madhouse'],
      externalIds: [animeId(ExternalProvider.MYANIME_LIST)],
    });
    const out = classifier.classify(c, {
      matched: true,
      provider: ExternalProvider.MYANIME_LIST,
      externalId: '1',
    });
    expect(out.classification).toBe('GENERAL');
  });

  it('leaves a non-candidate as GENERAL', () => {
    const c = detector.detect({ genres: ['Drama'] });
    const out = classifier.classify(c, undefined);
    expect(out.classification).toBe('GENERAL');
  });

  it('keeps Japanese live-action as GENERAL (not anime)', () => {
    const c = detector.detect({
      genres: ['Drama'],
      originalLanguage: 'ja',
      originCountries: ['JP'],
    });
    expect(c.isCandidate).toBe(false);
    expect(classifier.classify(c, undefined).classification).toBe('GENERAL');
  });
});
