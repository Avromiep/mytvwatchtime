import { ContentClassification } from '@prisma/client';
import { HydrationProcessor } from './hydration.processor';
import { CandidateDetectorService } from '../classification/candidate-detector.service';
import { ClassifierService } from '../classification/classifier.service';

/** animeHydrate: a FAILED anime match stays pending (no degraded persist, job throws);
 *  a successful negative match persists as the not-anime tag. */
describe('HydrationProcessor.animeHydrate', () => {
  let prisma: any;
  let animeMatch: any;
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
    };
    animeMatch = { matchAnime: jest.fn() };
    processor = new HydrationProcessor(
      {} as any, // redis
      prisma,
      new CandidateDetectorService(),
      new ClassifierService(),
      animeMatch,
      {} as any, // tvdb
      { enqueueAnimeHydrate: jest.fn() } as any, // queue
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
});
