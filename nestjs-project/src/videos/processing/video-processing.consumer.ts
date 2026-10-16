import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import {
  type ProcessVideoJobData,
  VIDEO_PROCESSING_JOBS,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import {
  PROCESSING_FAILURE_REASONS,
  ProcessingStageError,
  VideoProcessingService,
} from './video-processing.service';

/** Consumer of the `video-processing` queue; runs only in the video-worker (phase-03-videos/TD-07). */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingConsumer extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingConsumer.name);

  constructor(private readonly processingService: VideoProcessingService) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    switch (job.name) {
      case VIDEO_PROCESSING_JOBS.PROCESS:
        return this.processingService.process(job.data.videoId);
      case VIDEO_PROCESSING_JOBS.RECONCILE:
        await this.processingService.reconcileStuck();
        return;
      default:
        throw new Error(`Unknown video-processing job "${job.name}"`);
    }
  }

  /**
   * Retries and backoff belong to the queue; the row only becomes `error`
   * once the job has exhausted its attempts (phase-03-videos/TD-12).
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job || job.name !== VIDEO_PROCESSING_JOBS.PROCESS) return;

    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) {
      this.logger.warn(
        `Video ${job.data.videoId} attempt ${job.attemptsMade}/${attempts} failed: ${error.message}`,
      );
      return;
    }

    const reason =
      error instanceof ProcessingStageError
        ? error.reason
        : PROCESSING_FAILURE_REASONS.PROBE_FAILED;
    try {
      await this.processingService.markFailed(job.data.videoId, reason);
    } catch (err) {
      // Worker event handler: rethrowing would crash the worker; log instead.
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
