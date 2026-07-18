import { Ionicons } from '@expo/vector-icons';
import { computePercentages, type ReactionVoteSectionDto, type VoteSectionDto } from '@tvwatch/shared';

export type ReactionTypeKey =
  | 'SHOCKED' | 'FRUSTRATED' | 'SAD' | 'REFLECTIVE' | 'TOUCHED' | 'AMUSED'
  | 'SCARED' | 'BORED' | 'UNDERSTANDING' | 'THRILLED' | 'CONFUSED' | 'TENSE';

export const REACTION_ORDER: ReactionTypeKey[] = [
  'SHOCKED', 'FRUSTRATED', 'SAD', 'REFLECTIVE', 'TOUCHED', 'AMUSED',
  'SCARED', 'BORED', 'UNDERSTANDING', 'THRILLED', 'CONFUSED', 'TENSE',
];

export const REACTION_META: Record<ReactionTypeKey, { emoji: string; labelKey: string }> = {
  SHOCKED: { emoji: '😲', labelKey: 'episode:reactions.Shocked' },
  FRUSTRATED: { emoji: '😤', labelKey: 'episode:reactions.Frustrated' },
  SAD: { emoji: '😢', labelKey: 'episode:reactions.Sad' },
  REFLECTIVE: { emoji: '🤔', labelKey: 'episode:reactions.Reflective' },
  TOUCHED: { emoji: '🥹', labelKey: 'episode:reactions.Touched' },
  AMUSED: { emoji: '😄', labelKey: 'episode:reactions.Amused' },
  SCARED: { emoji: '😱', labelKey: 'episode:reactions.Scared' },
  BORED: { emoji: '😑', labelKey: 'episode:reactions.Bored' },
  UNDERSTANDING: { emoji: '💡', labelKey: 'episode:reactions.Understanding' },
  THRILLED: { emoji: '🤩', labelKey: 'episode:reactions.Thrilled' },
  CONFUSED: { emoji: '😕', labelKey: 'episode:reactions.Confused' },
  TENSE: { emoji: '😬', labelKey: 'episode:reactions.Tense' },
};

export type DeviceKey = 'PHONE' | 'TABLET' | 'COMPUTER' | 'TV';

export const DEVICE_ORDER: DeviceKey[] = ['PHONE', 'TABLET', 'COMPUTER', 'TV'];

export const DEVICE_META: Record<DeviceKey, { icon: keyof typeof Ionicons.glyphMap; labelKey: string }> = {
  PHONE: { icon: 'phone-portrait-outline', labelKey: 'episode:devices.Phone' },
  TABLET: { icon: 'tablet-portrait-outline', labelKey: 'episode:devices.Tablet' },
  COMPUTER: { icon: 'laptop-outline', labelKey: 'episode:devices.Computer' },
  TV: { icon: 'tv-outline', labelKey: 'episode:devices.TV' },
};

export const RATING_ORDER = [1, 2, 3, 4, 5] as const;

export const RATING_META: Record<number, string> = {
  1: 'episode:ratingBad',
  2: 'episode:ratingOK',
  3: 'episode:ratingGood',
  4: 'episode:ratingGreat',
  5: 'episode:ratingWow',
};

/** Map option value -> whole-number percent for a section (largest-remainder, sums to 100). */
export function sectionPercents(section: VoteSectionDto): Map<string, number> {
  const computed = computePercentages(section.options, section.total);
  return new Map(computed.map((o) => [o.value, o.percent]));
}

/**
 * Map option value -> whole-number percent for the multi-select reaction section.
 * Percentages are each reaction's share of ALL reaction picks (Σ counts), so the
 * displayed set sums to exactly 100 (largest-remainder rounding). Normalizing by
 * distinct reactors instead let many options each show 50–100% at once, since a
 * user may hold several reactions.
 */
export function reactionPercents(section: ReactionVoteSectionDto): Map<string, number> {
  const totalPicks = section.options.reduce((acc, o) => acc + o.count, 0);
  const computed = computePercentages(section.options, totalPicks);
  return new Map(computed.map((o) => [o.value, o.percent]));
}

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

/**
 * Compose a screen-reader label for a voting option:
 * "<name>[, selected][, <n> percent]". Words are localized via the a11y keys.
 */
export function composeOptionLabel(
  t: TFunc,
  name: string,
  selected: boolean,
  reveal: boolean,
  percent: number | undefined,
): string {
  const parts: string[] = [name];
  if (selected) parts.push(t('episode:a11y.selected'));
  if (reveal && percent != null) parts.push(t('episode:a11y.percent', { value: percent }));
  return parts.join(', ');
}
