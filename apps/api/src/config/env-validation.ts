import * as Joi from 'joi';

export const envValidation = {
  allowUnknown: true,
  abortEarly: false,
  validationSchema: Joi.object({
    NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
    LOG_LEVEL: Joi.string().valid('verbose', 'debug', 'log', 'warn', 'error').default('log'),
    API_PORT: Joi.number().default(4000),
    DATABASE_URL: Joi.string().optional().allow(''),
    REDIS_URL: Joi.string().optional().allow(''),
    // In production the JWT secret must be strong: >= 32 chars and not a placeholder
    // containing "change"/"CHANGE_ME". Elsewhere a shorter dev secret is allowed.
    JWT_SECRET: Joi.string()
      .min(16)
      .required()
      .when('NODE_ENV', {
        is: 'production',
        then: Joi.string()
          .min(32)
          .pattern(/change/i, { name: 'no-change-placeholder', invert: true })
          .required(),
      }),
    // In production the encryption master key must be set and must not be the dev default.
    ENCRYPTION_MASTER_KEY: Joi.string()
      .optional()
      .allow('')
      .when('NODE_ENV', {
        is: 'production',
        then: Joi.string().required().invalid('dev-master-key-change-in-prod-32bytes!'),
      }),
    JWT_ACCESS_TTL: Joi.string().default('15m'),
    JWT_REFRESH_TTL: Joi.string().default('30d'),
    APPLE_CLIENT_ID: Joi.string().optional().allow(''),
    APPLE_TEAM_ID: Joi.string().optional().allow(''),
    APPLE_KEY_ID: Joi.string().optional().allow(''),
    APPLE_PRIVATE_KEY: Joi.string().optional().allow(''),
    APPLE_PRIVATE_KEY_PATH: Joi.string().optional().allow(''),
  }),
};
