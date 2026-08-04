import { createHash } from 'crypto';
import { isTranslationEligible, TranslationService } from './translation.service';

describe('comment translation eligibility', () => {
  it.each(['', '   ', '😂🔥', '@someone', 'lol', 'LOL!!', 'haha', 'hahaha', 'hehe'])(
    'does not translate %p',
    (value) => expect(isTranslationEligible(value)).toBe(false),
  );

  it.each(['This is good', '@someone this is good', '¡Excelente!', '最高でした'])(
    'translates meaningful text %p',
    (value) => expect(isTranslationEligible(value)).toBe(true),
  );
});

describe('TranslationService content mapping', () => {
  const service = new TranslationService({} as any, {} as any, {} as any, {} as any);

  it('sanitizes review markdown and unsafe HTML', () => {
    const content = service.content(
      '**Great** <script>alert(1)</script><a href="javascript:bad()">bad</a>',
      {},
      'en',
      'html',
    );
    expect(content.originalHtml).toContain('<strong>Great</strong>');
    expect(content.originalHtml).not.toContain('<script');
    expect(content.originalHtml).not.toContain('javascript:');
  });

  it('returns only a cache entry matching the current source hash', () => {
    const source = 'Bonjour tout le monde';
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const content = service.content(
      source,
      {
        en: {
          cacheVersion: 2,
          text: 'Hello everyone',
          format: 'plain',
          sourceHash,
          translatedAt: '2026-08-03T00:00:00.000Z',
        },
      },
      'fr',
    );
    expect(content.translation?.text).toBe('Hello everyone');
    expect(content.translation?.sourceLanguage).toBe('fr');
  });

  it('does not expose a cached same-language detection as a translation', () => {
    const source = 'This is already English';
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const content = service.content(
      source,
      {
        en: {
          cacheVersion: 2,
          sameLanguage: true,
          text: source,
          format: 'plain',
          sourceHash,
          translatedAt: '2026-08-03T00:00:00.000Z',
        },
      },
      'en',
    );

    expect(content.eligible).toBe(false);
    expect(content.translation).toBeNull();
  });

  it('marks exact username mentions as non-translatable', () => {
    expect((service as any).protectMentions('Hello @alice and @bob_2')).toBe(
      'Hello <span translate="no">@alice</span> and <span translate="no">@bob_2</span>',
    );
  });

  it('prefers Translate contextual detection when standalone Detect gets short prose wrong', async () => {
    const prisma = {
      comment: {
        findUnique: jest.fn(async () => ({
          id: 'comment-1',
          body: 'This is an English sentence',
          language: null,
          translations: {},
          hidden: false,
          adminDeleted: false,
          deletedByUser: false,
        })),
      },
      $executeRaw: jest.fn(async () => 1),
    };
    const redis = {
      client: {
        set: jest.fn(async () => 'OK'),
        eval: jest.fn(async () => 1),
      },
    };
    const configured = { commentTranslation: true };
    const translating = new TranslationService(
      prisma as any,
      redis as any,
      {} as any,
      configured as any,
    );
    (translating as any).azure = jest
      .fn()
      .mockResolvedValueOnce([{ language: 'de', score: 0.91 }])
      .mockResolvedValueOnce([
        {
          detectedLanguage: { language: 'en', score: 1 },
          translations: [{ text: 'Ceci est une phrase anglaise' }],
        },
      ]);

    const result = await translating.translateComment('comment-1', 'fr');

    expect(result.sourceLanguage).toBe('en');
    expect((translating as any).azure.mock.calls[1][0]).not.toContain('&from=');
  });
});
