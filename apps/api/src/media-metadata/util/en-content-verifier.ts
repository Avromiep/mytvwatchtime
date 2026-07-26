/**
 * Version of the English-content verifier semantics. Bump when the suspect/verify
 * rules change — every row stamped with an older version (by the repair cron OR at
 * birth in `newMediaLocaleFields`) re-enters the verification pool exactly once.
 * Lives in a neutral module: metadata-backfill.service imports media-metadata.service,
 * so media-metadata.service cannot import the constant from the backfill service.
 */
export const EN_CONTENT_VERIFIER_VERSION = 3;
