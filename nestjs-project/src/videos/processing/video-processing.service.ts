import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import { LessThan, Repository } from 'typeorm';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import {
  MediaProbeService,
  NoVideoStreamError,
  type ProbeResult,
} from '../../media/media-probe.service';
import { STORAGE_BUCKETS } from '../../storage/storage.constants';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import { VIDEO_OBJECT_KEYS } from '../videos.constants';
import { VideoProcessingQueue } from './video-processing.queue';

/** Values stored in `videos.processing_error` (### Error Catalog → processing failures). */
export const PROCESSING_FAILURE_REASONS = {
  NO_VIDEO_STREAM: 'NO_VIDEO_STREAM',
  PROBE_FAILED: 'PROBE_FAILED',
  THUMBNAIL_FAILED: 'THUMBNAIL_FAILED',
} as const;

export type ProcessingFailureReason =
  (typeof PROCESSING_FAILURE_REASONS)[keyof typeof PROCESSING_FAILURE_REASONS];

const THUMBNAIL_JPEG_CONTENT_TYPE = 'image/jpeg';
const MAX_THUMBNAIL_OFFSET_SECONDS = 1;

/** A retryable failure tagged with the stage that failed, read on the last attempt. */
export class ProcessingStageError extends Error {
  constructor(
    public readonly reason: ProcessingFailureReason,
    cause: unknown,
  ) {
    super(
      `${reason}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'ProcessingStageError';
  }
}

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaProbeService: MediaProbeService,
    private readonly processingQueue: VideoProcessingQueue,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
    @Inject(queueConfig.KEY)
    private readonly queue: ConfigType<typeof queueConfig>,
  ) {}

  /**
   * Extracts metadata, stores the thumbnail and moves the video to `ready`
   * (phase-03-videos/TD-08, TD-09, TD-12). Idempotent: anything not in
   * `processing` is left untouched, so redelivered jobs are harmless.
   */
  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video || video.status !== VideoStatus.PROCESSING) {
      this.logger.log(
        `Skipping video ${videoId}: ${video ? `status is ${video.status}` : 'not found'}`,
      );
      return;
    }

    const sourceUrl = await this.storageService.presignGet(
      STORAGE_BUCKETS.VIDEOS,
      video.source_key,
      this.storage.playbackUrlTtlSeconds,
    );

    const probe = await this.probe(videoId, sourceUrl);
    const thumbnailKey = await this.storeThumbnail(videoId, sourceUrl, probe);

    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        duration_seconds: probe.durationSeconds,
        width: probe.width,
        height: probe.height,
        format_name: probe.formatName,
        probe_metadata: probe.raw,
        thumbnail_key: thumbnailKey,
        status: VideoStatus.READY,
        processed_at: new Date(),
      },
    );
  }

  /**
   * Re-enqueues videos stuck in `processing` (e.g. the enqueue after commit
   * failed, or Redis lost the job). The deterministic jobId makes BullMQ
   * ignore videos whose job is still in the queue (video-processing-job-delivery/TD-01).
   */
  async reconcileStuck(): Promise<number> {
    const cutoff = new Date(Date.now() - this.queue.reconcileStuckAfterMs);
    const stuck = await this.videoRepository.find({
      select: { id: true },
      where: { status: VideoStatus.PROCESSING, updated_at: LessThan(cutoff) },
    });
    for (const { id } of stuck) {
      await this.processingQueue.enqueueProcess(id);
    }
    if (stuck.length > 0) {
      this.logger.log(
        `Re-enqueued ${stuck.length} video(s) stuck in processing`,
      );
    }
    return stuck.length;
  }

  /** Terminal failure: only a video still in `processing` is moved to `error`. */
  async markFailed(
    videoId: string,
    reason: ProcessingFailureReason,
  ): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      { status: VideoStatus.ERROR, processing_error: reason },
    );
  }

  private async probe(
    videoId: string,
    sourceUrl: string,
  ): Promise<ProbeResult> {
    try {
      return await this.mediaProbeService.probe(sourceUrl);
    } catch (err) {
      if (err instanceof NoVideoStreamError) {
        // The declared content type lied (phase-03-videos/TD-05): retrying cannot help.
        await this.markFailed(
          videoId,
          PROCESSING_FAILURE_REASONS.NO_VIDEO_STREAM,
        );
        throw new UnrecoverableError(
          PROCESSING_FAILURE_REASONS.NO_VIDEO_STREAM,
        );
      }
      throw new ProcessingStageError(
        PROCESSING_FAILURE_REASONS.PROBE_FAILED,
        err,
      );
    }
  }

  private async storeThumbnail(
    videoId: string,
    sourceUrl: string,
    probe: ProbeResult,
  ): Promise<string> {
    const key = VIDEO_OBJECT_KEYS.thumbnail(videoId);
    try {
      const jpeg = await this.mediaProbeService.extractThumbnail(
        sourceUrl,
        Math.min(MAX_THUMBNAIL_OFFSET_SECONDS, probe.durationSeconds / 2),
      );
      await this.storageService.putObject(
        STORAGE_BUCKETS.THUMBNAILS,
        key,
        jpeg,
        THUMBNAIL_JPEG_CONTENT_TYPE,
      );
      return key;
    } catch (err) {
      throw new ProcessingStageError(
        PROCESSING_FAILURE_REASONS.THUMBNAIL_FAILED,
        err,
      );
    }
  }
}
