import type { JobsOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';

export const VIDEO_PROCESSING_JOBS = {
  PROCESS: 'process',
  RECONCILE: 'reconcile',
} as const;

export const RECONCILE_SCHEDULER_ID = 'reconcile-stuck-videos';

export interface ProcessVideoJobData {
  videoId: string;
}

/** Deterministic id: re-enqueues dedupe while the job is still in the queue. */
export const processJobId = (videoId: string): string => `process-${videoId}`;

/** Retry/retention policy for `process` jobs (phase-03-videos/TD-06, ### Events/Messages). */
export const PROCESS_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 86400 },
  removeOnFail: { age: 604800 },
} as const satisfies JobsOptions;
