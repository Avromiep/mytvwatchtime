import { ContentClassification } from '@prisma/client';
import { HydrationProcessor } from './hydration.processor';
import { CandidateDetectorService } from '../classification/candidate-detector.service';
import { ClassifierService } from '../classification/classifier.service';

/** animeHydrate: a FAILED anime match stays pending (no degraded persist, job throws);
 *  a successful negative match persists as the not-anime tag. */
describe('HydrationProcessor.animeHydrate', () => {
  let prisma: any;
  let animeMatch: any;
  let tmdb: any;
  let processor: HydrationProcessor;

  const media = {
    id: 'm1',
    title: 'Naruto',
    type: 'SHOW',
    manualClassification: false,
    manualCandidate: false,
    genres: [{ genre: { name: 'Animation' } }],
    externalIds: [],
    show: { yearStart: 2002, originalLanguage: 'ja', originCountries: ['JP'] },
    movie: null,
  };

  beforeEach(() => {
    prisma = {
      mediaItem: {
        findUnique: jest.fn().mockResolvedValue(media),
        update: jest.fn().mockResolvedValue({}),
      },
      show: { update: jest.fn().mockResolvedValue({}) },
      movie: { update: jest.fn().mockResolvedValue({}) },
    };
    animeMatch = { matchAnime: jest.fn() };
    tmdb = { enabled: true, getShowKeywords: jest.fn(), getMovieKeywords: jest.fn() };
    processor = new HydrationProcessor(
      {} as any, // redis
      prisma,
      new CandidateDetectorService(),
      new ClassifierService(),
      animeMatch,
      {} as any, // tvdb
      tmdb,
      { enqueueAnimeHydrate: jest.fn() } as any, // queue
      { ensureShowFullTvdb: jest.fn().mockResolvedValue('m1') } as any, // meta
    );
  });

  it('rethrows a transient match failure WITHOUT persisting a degraded classification', async () => {
    animeMatch.matchAnime.mockRejectedValue(new Error('kitsu 429'));
    await expect(processor.animeHydrate('m1')).rejects.toThrow('kitsu 429');
    expect(prisma.mediaItem.update).not.toHaveBeenCalled();
  });

  it('persists the successful-match classification (anime confirmed)', async () => {
    animeMatch.matchAnime.mockResolvedValue({
      matched: true,
      provider: 'KITSU',
      externalId: 'k1',
      confidence: 0.9,
    });
    await processor.animeHydrate('m1');
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: expect.objectContaining({ contentClassification: 'ANIME' as ContentClassification }),
    });
  });

  it('persists GENERAL for a successful no-match (tagged — not re-checked until rehydration)', async () => {
    // Animation genre but no Japanese evidence (Western animation): stays GENERAL.
    prisma.mediaItem.findUnique.mockResolvedValue({
      ...media,
      title: 'The Simpsons',
      show: { yearStart: 1989, originalLanguage: 'en', originCountries: ['US'] },
    });
    animeMatch.matchAnime.mockResolvedValue({ matched: false, reason: 'no_match' });
    await processor.animeHydrate('m1');
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: expect.objectContaining({ contentClassification: 'GENERAL' as ContentClassification }),
    });
  });

  it('short-circuits Kitsu/Jikan entirely when the TMDB `anime` keyword is present', async () => {
    prisma.mediaItem.findUnique.mockResolvedValue({
      ...media,
      show: {
        yearStart: 2016,
        originalLanguage: 'ja',
        originCountries: ['JP'],
        keywords: ['anime', 'isekai'],
      },
    });
    await processor.animeHydrate('m1');
    expect(tmdb.getShowKeywords).not.toHaveBeenCalled(); // already persisted — no refetch
    expect(animeMatch.matchAnime).not.toHaveBeenCalled();
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: expect.objectContaining({
        contentClassification: 'ANIME' as ContentClassification,
        classificationTier: 'confirmed',
        classificationConfidence: 0.9,
      }),
    });
  });

  it('backfills keywords for old rows BEFORE matching — anime keyword skips Kitsu/Jikan', async () => {
    prisma.mediaItem.findUnique.mockResolvedValue({
      ...media,
      externalIds: [{ provider: 'TMDB', providerEntityKind: 'SERIES', value: '65942' }],
      show: { yearStart: 2016, originalLanguage: 'ja', originCountries: ['JP'], keywords: null },
    });
    tmdb.getShowKeywords.mockResolvedValue(['anime', 'isekai']);
    await processor.animeHydrate('m1');
    expect(tmdb.getShowKeywords).toHaveBeenCalledWith(65942);
    expect(prisma.show.update).toHaveBeenCalledWith({
      where: { mediaId: 'm1' },
      data: { keywords: ['anime', 'isekai'] },
    });
    expect(animeMatch.matchAnime).not.toHaveBeenCalled();
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: expect.objectContaining({
        contentClassification: 'ANIME' as ContentClassification,
        classificationTier: 'confirmed',
        classificationConfidence: 0.9,
      }),
    });
  });

  it('marks old rows as checked and proceeds to Kitsu/Jikan when no anime keyword exists', async () => {
    prisma.mediaItem.findUnique.mockResolvedValue({
      ...media,
      externalIds: [{ provider: 'TMDB', providerEntityKind: 'SERIES', value: '1' }],
      show: { yearStart: 2002, originalLanguage: 'ja', originCountries: ['JP'], keywords: null },
    });
    tmdb.getShowKeywords.mockResolvedValue(['magic']);
    animeMatch.matchAnime.mockResolvedValue({
      matched: true,
      provider: 'KITSU',
      externalId: 'k1',
      confidence: 0.9,
    });
    await processor.animeHydrate('m1');
    expect(prisma.show.update).toHaveBeenCalledWith({
      where: { mediaId: 'm1' },
      data: { keywords: ['magic'] },
    });
    expect(animeMatch.matchAnime).toHaveBeenCalled();
  });

  it('does not persist keywords on a provider error (row stays eligible for retry)', async () => {
    prisma.mediaItem.findUnique.mockResolvedValue({
      ...media,
      externalIds: [{ provider: 'TMDB', providerEntityKind: 'SERIES', value: '1' }],
      show: { yearStart: 2002, originalLanguage: 'ja', originCountries: ['JP'], keywords: null },
    });
    tmdb.getShowKeywords.mockResolvedValue(null);
    animeMatch.matchAnime.mockResolvedValue({ matched: false, reason: 'no_match' });
    await processor.animeHydrate('m1');
    expect(prisma.show.update).not.toHaveBeenCalled();
    expect(animeMatch.matchAnime).toHaveBeenCalled();
  });
});
