import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CommentThreadType, MediaType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

/** Max stored length for a GIPHY media URL. */
export const GIF_URL_MAX_LENGTH = 2048;

/**
 * Validate that a URL is an HTTPS URL hosted by GIPHY-controlled domains.
 * Allows exactly `giphy.com` or any subdomain ending in `.giphy.com`.
 * Rejects data:, file:, javascript:, localhost, private IPs, and other hosts
 * by virtue of the https + host allowlist.
 */
export function isAllowedGiphyUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== 'string') return false;
  if (url.length > GIF_URL_MAX_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (host === 'giphy.com') return true;
  if (host.endsWith('.giphy.com')) return true;
  return false;
}

/** Sort order accepted by comment list + reply endpoints. */
export const COMMENT_SORTS = ['LATEST', 'MOST_LIKED'] as const;
export type CommentSort = (typeof COMMENT_SORTS)[number];

export class CreateCommentDto {
  @ApiProperty({ enum: CommentThreadType })
  @IsEnum(CommentThreadType)
  threadType!: CommentThreadType;

  @ApiProperty()
  @IsString()
  threadId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional({ description: 'Final GIPHY media URL (https, *.giphy.com)' })
  @IsOptional()
  @IsString()
  @MaxLength(GIF_URL_MAX_LENGTH)
  gifUrl?: string;

  @ApiPropertyOptional({
    enum: MediaType,
    description: 'Attached show/movie card type. Requires mediaId.',
  })
  @IsOptional()
  @IsEnum(MediaType)
  mediaType?: MediaType;

  @ApiPropertyOptional({
    description: 'Attached show/movie card id (media_items id). Requires mediaType.',
  })
  @IsOptional()
  @IsString()
  mediaId?: string;

  @ApiPropertyOptional({
    description: 'Attached custom-list card id. Exclusive with other attachments.',
  })
  @IsOptional()
  @IsString()
  listId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  parentId?: string;
}

export class UpdateCommentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  body?: string;

  @ApiPropertyOptional({ description: 'Set to null to clear an existing GIF attachment.' })
  @IsOptional()
  @IsString()
  @MaxLength(GIF_URL_MAX_LENGTH)
  gifUrl?: string | null;

  @ApiPropertyOptional({
    description: 'When true, detaches (deletes) the current image attachment.',
  })
  @IsOptional()
  @IsBoolean()
  detachImage?: boolean;
}

function normalizeSort(sort?: string): CommentSort {
  return sort === 'MOST_LIKED' ? 'MOST_LIKED' : 'LATEST';
}

export class CommentQueryDto {
  @ApiProperty({ enum: CommentThreadType })
  @IsEnum(CommentThreadType)
  threadType!: CommentThreadType;

  @ApiProperty()
  @IsString()
  threadId!: string;

  @ApiPropertyOptional({ enum: COMMENT_SORTS, default: 'LATEST' })
  @IsOptional()
  @IsString()
  sort?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number = 20;

  get resolvedSort(): CommentSort {
    return normalizeSort(this.sort);
  }
}

export class RepliesQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: COMMENT_SORTS, default: 'LATEST' })
  @IsOptional()
  @IsString()
  sort?: string;

  @ApiPropertyOptional({
    enum: [1, 2],
    default: 1,
    description:
      'Levels of descendants returned relative to the requested comment. 1 = direct children only ' +
      "(paginated). 2 = additionally each direct child's first children (capped per parent), flat " +
      'in the same items array; total always counts direct children only.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2)
  depth?: number = 1;

  get resolvedSort(): CommentSort {
    return normalizeSort(this.sort);
  }
}

export class ReportCommentDto {
  @ApiProperty()
  @IsString()
  reason!: string;
}
