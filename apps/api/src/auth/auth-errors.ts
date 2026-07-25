import { HttpException, HttpStatus } from '@nestjs/common';
import { AuthErrorCode } from '@tvwatch/shared';

function authException(status: HttpStatus, code: AuthErrorCode, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

export function unauthorizedAuth(code: AuthErrorCode, message: string): HttpException {
  return authException(HttpStatus.UNAUTHORIZED, code, message);
}

export function conflictAuth(code: AuthErrorCode, message: string): HttpException {
  return authException(HttpStatus.CONFLICT, code, message);
}

export function badRequestAuth(code: AuthErrorCode, message: string): HttpException {
  return authException(HttpStatus.BAD_REQUEST, code, message);
}

export function serviceUnavailableAuth(code: AuthErrorCode, message: string): HttpException {
  return authException(HttpStatus.SERVICE_UNAVAILABLE, code, message);
}
