import { Paginated, PaginationQuery } from './common';
import { NotificationCategory, NotificationSort } from './enums';

export interface NotificationItemDto {
  id: string;
  category: NotificationCategory;
  title: string;
  body?: string | null;
  imageUrl?: string | null;
  iconUrl?: string | null;
  actorAvatarUrl?: string | null;
  link?: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationPreferencesDto {
  preferences: Record<NotificationCategory, { push: boolean; inApp: boolean }>;
  quietHoursEnabled: boolean;
  quietHoursStart?: string | null; // "22:00"
  quietHoursEnd?: string | null; // "08:00"
  timezone?: string | null;
}

export interface NotificationQuery extends PaginationQuery {
  unreadOnly?: boolean;
  sort?: NotificationSort;
}

export interface PaginatedNotifications extends Paginated<NotificationItemDto> {}

export type ProviderOfferType = 'STREAM' | 'RENT' | 'BUY';

/** One watch-provider availability subscription for a media + offer type. */
export interface ProviderAlertDto {
  offerType: ProviderOfferType;
  /** ISO 3166-1 country whose offers are matched. */
  country: string;
  /** TMDB provider ids; empty = any provider. */
  providerIds: number[];
  active: boolean;
  notifiedAt?: string | null;
}

/** Regional catalog entry for the alert picker. */
export interface WatchProviderCatalogEntryDto {
  /** TMDB provider id. */
  id: number;
  name: string;
  logoUrl?: string | null;
}

export interface UpdateNotificationPreferencesDto {
  preferences?: Record<NotificationCategory, { push: boolean; inApp: boolean }>;
  quietHoursEnabled?: boolean;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  timezone?: string | null;
}
