import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Body for the public push relay. Length caps bound abuse / payload size. */
export class PushRelayDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  token!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  body?: string;

  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}
