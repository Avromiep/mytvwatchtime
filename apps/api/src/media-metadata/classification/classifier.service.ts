import { Injectable } from '@nestjs/common';
import type { CandidateResult, ClassificationResult, ProviderMatchResult } from './types';

/**
 * Final content classification (Phase 7). Runs AFTER provider matching (Phase 6) and
 * candidate detection (Phase 4). Non-circular: classification never precedes matching.
 *
 * Automatic ANIME classification has one authority: TMDB Animation genre AND the
 * TMDB `anime` keyword. Kitsu/Jikan matches remain enrichment evidence only.
 *
 * Manga is never auto-emitted from SHOW/MOVIE metadata: in the classification-only
 * scope, manga publications are not stored as media rows, and adaptations must not be
 * classified as manga. (Publication-specific manga matching is handled internally.)
 */
@Injectable()
export class ClassifierService {
  classify(
    candidate: CandidateResult,
    match: ProviderMatchResult | null | undefined,
  ): ClassificationResult {
    const ev = candidate.evidence ?? {};
    const hasAnimation =
      ev.tmdbAnimation === true || candidate.signals.includes('tmdb_animation_genre');
    const hasAnimeKeyword = ev.animeKeyword === true || candidate.signals.includes('anime_keyword');
    const enrichment =
      match?.matched === true
        ? { enrichmentProvider: match.provider, enrichmentId: match.externalId }
        : {};
    if (hasAnimation && hasAnimeKeyword) {
      return {
        classification: 'ANIME',
        tier: 'confirmed',
        confidence: 0.95,
        evidence: {
          ...ev,
          ...enrichment,
          authority: 'TMDB',
          rule: 'animation_genre_and_anime_keyword',
        },
      };
    }
    return {
      classification: 'GENERAL',
      tier: 'confirmed',
      confidence: 0,
      evidence: {
        ...ev,
        ...enrichment,
        authority: 'TMDB',
        reason: 'strict_tmdb_rule_not_satisfied',
      },
    };
  }
}
