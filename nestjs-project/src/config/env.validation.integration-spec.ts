import type { ValidationResult } from 'joi';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ACCESS_KEY: 'access-key',
  STORAGE_SECRET_KEY: 'secret-key',
};

const validate = (
  env: Record<string, string>,
): ValidationResult<Record<string, unknown>> =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    // Joi types `value` as `any` on the error branch of its result union.
    const value = result.value as Record<string, unknown>;
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue', () => {
  it('should apply storage and queue defaults when only credentials are set', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    // Joi types `value` as `any` on the error branch of its result union.
    const value = result.value as Record<string, unknown>;
    expect(value).toMatchObject({
      STORAGE_ENDPOINT: 'http://minio:9000',
      STORAGE_REGION: 'us-east-1',
      STORAGE_FORCE_PATH_STYLE: 'true',
      STORAGE_VIDEOS_BUCKET: 'streamtube-videos',
      STORAGE_THUMBNAILS_BUCKET: 'streamtube-thumbnails',
      STORAGE_UPLOAD_PART_SIZE_BYTES: 67108864,
      STORAGE_UPLOAD_URL_TTL_SECONDS: 21600,
      STORAGE_PLAYBACK_URL_TTL_SECONDS: 3600,
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      QUEUE_PREFIX: 'streamtube',
      VIDEO_RECONCILE_INTERVAL_MS: 300000,
      VIDEO_RECONCILE_STUCK_AFTER_MS: 900000,
    });
  });

  it.each(['STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY'])(
    'should reject a missing %s',
    (key) => {
      const env: Record<string, string> = { ...requiredEnv };
      delete env[key];
      const { error } = envValidationSchema.validate(env, {
        allowUnknown: true,
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should reject STORAGE_UPLOAD_PART_SIZE_BYTES below the 5MiB S3 minimum', () => {
    const { error } = validate({ STORAGE_UPLOAD_PART_SIZE_BYTES: '5242879' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_UPLOAD_PART_SIZE_BYTES');
  });

  it('should accept STORAGE_UPLOAD_PART_SIZE_BYTES at the 5MiB minimum', () => {
    const { error } = validate({ STORAGE_UPLOAD_PART_SIZE_BYTES: '5242880' });
    expect(error).toBeUndefined();
  });
});
