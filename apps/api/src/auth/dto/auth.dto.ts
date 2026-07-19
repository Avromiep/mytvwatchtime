import { ApiProperty } from '@nestjs/swagger';
import { AuthProvider } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

export class EmailRegisterDto {
  @ApiProperty()
  @IsString()
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  username!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  password!: string;
}

export class EmailLoginDto {
  @ApiProperty()
  @IsString()
  email!: string;

  @ApiProperty()
  @IsString()
  password!: string;

  /** Long-lived access token (30d) for trusted "stay connected" sessions (admin console). */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}

export class SocialLoginDto {
  @ApiProperty({ enum: AuthProvider })
  @IsEnum(AuthProvider)
  provider!: AuthProvider;

  @ApiProperty({ required: false, description: 'ID token (Google/Apple) or access token (Facebook)' })
  @IsOptional()
  @IsString()
  token?: string;

  @ApiProperty({ required: false, description: 'OAuth authorization code (for code exchange flow)' })
  @IsOptional()
  @IsString()
  authorizationCode?: string;

  @ApiProperty({ required: false, description: 'Redirect URI used for the OAuth flow' })
  @IsOptional()
  @IsString()
  redirectUri?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  nonce?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  username?: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  refreshToken!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  oldPassword!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  newPassword!: string;
}

export class ForgotPasswordDto {
  @ApiProperty()
  @IsString()
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  token!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  newPassword!: string;
}
