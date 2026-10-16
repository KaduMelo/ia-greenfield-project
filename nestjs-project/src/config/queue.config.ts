import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  redisHost: process.env.REDIS_HOST || 'redis',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  prefix: process.env.QUEUE_PREFIX || 'streamtube',
  reconcileIntervalMs: parseInt(
    process.env.VIDEO_RECONCILE_INTERVAL_MS || '300000',
    10,
  ),
  reconcileStuckAfterMs: parseInt(
    process.env.VIDEO_RECONCILE_STUCK_AFTER_MS || '900000',
    10,
  ),
}));
