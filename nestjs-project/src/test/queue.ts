import { Queue } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../videos/processing/video-processing.constants';

export const TEST_QUEUE_PREFIX = 'streamtube-test';

/**
 * Points the queue config at a test-only Redis key prefix so jobs created by
 * the suites never reach the real `video-worker`. Must run before compiling.
 */
export function useTestQueuePrefix(): void {
  process.env.QUEUE_PREFIX = TEST_QUEUE_PREFIX;
}

export function openVideoProcessingQueue(
  prefix: string = TEST_QUEUE_PREFIX,
): Queue {
  return new Queue(VIDEO_PROCESSING_QUEUE, {
    prefix,
    connection: {
      host: process.env.REDIS_HOST ?? 'redis',
      port: Number(process.env.REDIS_PORT ?? 6379),
    },
  });
}
