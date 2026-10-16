import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { S3ServiceException } from '@aws-sdk/client-s3';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidVideoStateException,
  UploadCompletionFailedException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { STORAGE_BUCKETS } from '../storage/storage.constants';
import { StorageService, type UploadedPart } from '../storage/storage.service';
import type { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { CreateVideoResponseDto } from './dto/create-video-response.dto';
import type { PlaybackUrlResponseDto } from './dto/playback-url-response.dto';
import type { VideoResponseDto } from './dto/video-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingQueue } from './processing/video-processing.queue';
import { generatePublicId } from './public-id.util';
import { PUBLIC_ID_MAX_ATTEMPTS, VIDEO_OBJECT_KEYS } from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';
export const UPLOAD_SIZE_MISMATCH_REASON = 'UPLOAD_SIZE_MISMATCH';

/** Storage errors meaning "the client's part list is wrong", not an outage. */
export type PlaybackKind = 'stream' | 'download';

/** Strips characters that could break out of the quoted `filename` parameter. */
function attachmentDisposition(filename: string): string {
  return `attachment; filename="${filename.replace(/["\\\r\n]/g, '_')}"`;
}

const REJECTED_COMPLETION_ERRORS = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'NoSuchUpload',
  'EntityTooSmall',
]);

function isRejectedCompletion(err: unknown): boolean {
  return (
    err instanceof S3ServiceException &&
    REJECTED_COMPLETION_ERRORS.has(err.name)
  );
}

function isPublicIdCollision(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as QueryFailedError & { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(PUBLIC_ID_COLUMN)
  );
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly processingQueue: VideoProcessingQueue,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * Pre-registers the video as a draft and starts a direct-to-storage multipart
   * upload; no video bytes ever pass through the API (phase-03-videos/TD-03, TD-04).
   */
  async createUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Every user gets a channel at registration (Phase 02); absence is a broken invariant.
      throw new Error(`User ${userId} has no channel`);
    }

    const id = randomUUID();
    const sourceKey = VIDEO_OBJECT_KEYS.source(id);
    const partSize = this.storage.uploadPartSizeBytes;
    const partCount = Math.ceil(dto.fileSize / partSize);

    const uploadId = await this.storageService.createMultipartUpload(
      sourceKey,
      dto.contentType,
    );

    let video: Video;
    try {
      video = await this.insertWithUniquePublicId({
        id,
        channel_id: channel.id,
        title: dto.title,
        original_filename: dto.fileName,
        content_type: dto.contentType,
        declared_size_bytes: String(dto.fileSize),
        upload_id: uploadId,
        source_key: sourceKey,
      });
    } catch (err) {
      await this.storageService.abortMultipartUpload(sourceKey, uploadId);
      throw err;
    }

    const ttlSeconds = this.storage.uploadUrlTtlSeconds;
    const parts = await this.storageService.presignUploadParts(
      sourceKey,
      uploadId,
      partCount,
      ttlSeconds,
    );

    return {
      id: video.id,
      publicId: video.public_id,
      status: VideoStatus.UPLOADING,
      publicationStatus: video.publication_status,
      uploadId,
      partSize,
      parts,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }

  /**
   * Closes the upload handshake: completes the multipart, enforces the real
   * size against the declared one and moves the video to `processing`,
   * enqueuing the job only after that commit (phase-03-videos/TD-04, TD-05;
   * video-processing-job-delivery/TD-01).
   */
  async completeUpload(
    userId: string,
    id: string,
    parts: UploadedPart[],
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.findOwnedById(userId, id);
    if (video.status !== VideoStatus.UPLOADING || !video.upload_id) {
      throw new InvalidVideoStateException();
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.source_key,
        video.upload_id,
        parts,
      );
    } catch (err) {
      if (isRejectedCompletion(err)) {
        throw new UploadCompletionFailedException();
      }
      throw err;
    }

    const head = await this.storageService.headObject(
      STORAGE_BUCKETS.VIDEOS,
      video.source_key,
    );
    if (!head || head.contentLength !== Number(video.declared_size_bytes)) {
      await this.storageService.deleteObject(
        STORAGE_BUCKETS.VIDEOS,
        video.source_key,
      );
      await this.videoRepository.update(
        { id: video.id },
        {
          status: VideoStatus.ERROR,
          processing_error: UPLOAD_SIZE_MISMATCH_REASON,
          upload_id: null,
        },
      );
      throw new UploadSizeMismatchException();
    }

    // Conditional transition: a concurrent completion that already moved the
    // video out of `uploading` makes this a no-op instead of a double enqueue.
    const { affected } = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.UPLOADING },
      {
        status: VideoStatus.PROCESSING,
        size_bytes: String(head.contentLength),
        upload_id: null,
      },
    );
    if (!affected) {
      throw new InvalidVideoStateException();
    }

    try {
      await this.processingQueue.enqueueProcess(video.id);
    } catch (err) {
      // Deliberately not rethrown (video-processing-job-delivery/TD-01): the
      // `processing` row is the durable record and the reconciliation sweep
      // re-enqueues it, so the upload itself has succeeded.
      this.logger.error(
        `Failed to enqueue processing for video ${video.id}; reconciliation will retry`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    return {
      id: video.id,
      publicId: video.public_id,
      status: VideoStatus.PROCESSING,
    };
  }

  /** Reads a video of the caller's channel by its unique public id (phase-03-videos/TD-10). */
  async getVideo(userId: string, publicId: string): Promise<VideoResponseDto> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    const thumbnailUrl = video.thumbnail_key
      ? await this.storageService.presignGet(
          STORAGE_BUCKETS.THUMBNAILS,
          video.thumbnail_key,
          this.storage.playbackUrlTtlSeconds,
        )
      : null;

    return {
      id: video.id,
      publicId: video.public_id,
      title: video.title,
      status: video.status,
      publicationStatus: video.publication_status,
      processingError: video.processing_error,
      durationSeconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      sizeBytes: video.size_bytes === null ? null : Number(video.size_bytes),
      formatName: video.format_name,
      thumbnailUrl,
      createdAt: video.created_at.toISOString(),
      processedAt: video.processed_at ? video.processed_at.toISOString() : null,
    };
  }

  /**
   * Short-lived presigned GET for streaming or download; the storage serves
   * Range / 206 natively and the API stays out of the byte path
   * (phase-03-videos/TD-11). Only `ready` videos can be played.
   */
  async getPlaybackUrl(
    userId: string,
    publicId: string,
    kind: PlaybackKind,
  ): Promise<PlaybackUrlResponseDto> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }

    const ttlSeconds = this.storage.playbackUrlTtlSeconds;
    const url = await this.storageService.presignGet(
      STORAGE_BUCKETS.VIDEOS,
      video.source_key,
      ttlSeconds,
      kind === 'download'
        ? { contentDisposition: attachmentDisposition(video.original_filename) }
        : {},
    );
    return {
      url,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }

  private async findOwnedByPublicId(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    return this.findOwned(userId, { public_id: publicId });
  }

  /** Loads a video of the caller's channel; other channels' videos are reported as not found. */
  private async findOwnedById(userId: string, id: string): Promise<Video> {
    return this.findOwned(userId, { id });
  }

  private async findOwned(
    userId: string,
    where: Pick<Partial<Video>, 'id' | 'public_id'>,
  ): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    const video = channel
      ? await this.videoRepository.findOneBy({
          ...where,
          channel_id: channel.id,
        })
      : null;
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async insertWithUniquePublicId(
    fields: Partial<Video>,
  ): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...fields,
            public_id: generatePublicId(),
          }),
        );
      } catch (err) {
        if (!isPublicIdCollision(err) || attempt >= PUBLIC_ID_MAX_ATTEMPTS) {
          throw err;
        }
      }
    }
  }
}
