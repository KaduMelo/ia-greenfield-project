import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { type Queue, UnrecoverableError } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import { MediaModule } from '../../media/media.module';
import { QueueModule } from '../../queue/queue.module';
import { STORAGE_BUCKETS } from '../../storage/storage.constants';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { openVideoProcessingQueue, useTestQueuePrefix } from '../../test/queue';
import {
  TEST_BUCKETS,
  clearTestBuckets,
  createTestS3Client,
  useTestStorageBuckets,
} from '../../test/storage';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from '../entities/video.entity';
import { generatePublicId } from '../public-id.util';
import {
  ProcessingStageError,
  VideoProcessingService,
} from './video-processing.service';
import { VideoProcessingQueue } from './video-processing.queue';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const FIXTURES = resolve(__dirname, '../../../test/fixtures');
const STUCK_AFTER_MS = 60_000;

describe('VideoProcessingService (integration)', () => {
  let module: TestingModule;
  let service: VideoProcessingService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let s3: S3Client;
  let queue: Queue;
  let counter = 0;

  beforeAll(async () => {
    useTestStorageBuckets();
    useTestQueuePrefix();
    process.env.VIDEO_RECONCILE_STUCK_AFTER_MS = String(STUCK_AFTER_MS);
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        MediaModule,
        QueueModule,
      ],
      providers: [VideoProcessingService, VideoProcessingQueue],
    }).compile();
    service = module.get(VideoProcessingService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    s3 = createTestS3Client();
    queue = openVideoProcessingQueue();
  }, 30000);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await clearTestBuckets(s3);
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await clearTestBuckets(s3);
    await queue.obliterate({ force: true });
    await queue.close();
    s3.destroy();
    await module.close();
  });

  /** Inserts a video in `status` and, when given, uploads `fixture` as its source object. */
  async function seedVideo(
    status: VideoStatus,
    fixture?: string,
  ): Promise<Video> {
    const n = ++counter;
    const user = await dataSource.getRepository(User).save({
      email: `processing_${n}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `Channel ${n}`,
      nickname: `processing_${n}`,
      user_id: user.id,
    });
    const id = randomUUID();
    const sourceKey = `${id}/source`;
    if (fixture) {
      await storage.putObject(
        STORAGE_BUCKETS.VIDEOS,
        sourceKey,
        await readFile(resolve(FIXTURES, fixture)),
        'video/mp4',
      );
    }
    return videoRepository.save({
      id,
      channel_id: channel.id,
      public_id: generatePublicId(),
      title: 'Processing',
      original_filename: fixture ?? 'missing.mp4',
      content_type: 'video/mp4',
      declared_size_bytes: '1',
      source_key: sourceKey,
      status,
    });
  }

  it('should extract metadata, store the thumbnail and move the video to ready', async () => {
    const video = await seedVideo(VideoStatus.PROCESSING, 'sample.mp4');

    await service.process(video.id);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.duration_seconds).toBeCloseTo(2.0, 1);
    expect(row.width).toBe(320);
    expect(row.height).toBe(240);
    expect(row.format_name).toContain('mp4');
    expect(row.probe_metadata).toHaveProperty('streams');
    expect(row.processed_at).toBeInstanceOf(Date);
    expect(row.thumbnail_key).toBe(`${video.id}/default.jpg`);

    const thumb = await s3.send(
      new HeadObjectCommand({
        Bucket: TEST_BUCKETS.thumbnails,
        Key: `${video.id}/default.jpg`,
      }),
    );
    expect(thumb.ContentType).toBe('image/jpeg');
    expect(thumb.ContentLength).toBeGreaterThan(0);
  });

  it('should mark a source without a video stream as NO_VIDEO_STREAM and stop retrying', async () => {
    const video = await seedVideo(VideoStatus.PROCESSING, 'audio-only.m4a');

    await expect(service.process(video.id)).rejects.toThrow(UnrecoverableError);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.ERROR);
    expect(row.processing_error).toBe('NO_VIDEO_STREAM');
  });

  it('should leave a video that is not processing untouched', async () => {
    const video = await seedVideo(VideoStatus.READY, 'sample.mp4');

    await service.process(video.id);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.thumbnail_key).toBeNull();
    expect(row.updated_at).toEqual(video.updated_at);
  });

  it('should raise a retryable PROBE_FAILED and keep processing when the source is unreadable', async () => {
    const video = await seedVideo(VideoStatus.PROCESSING);

    const error = await service.process(video.id).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProcessingStageError);
    expect((error as ProcessingStageError).reason).toBe('PROBE_FAILED');
    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.PROCESSING);
  });

  it('should move only a processing video to error in markFailed', async () => {
    const processing = await seedVideo(VideoStatus.PROCESSING);
    const ready = await seedVideo(VideoStatus.READY);

    await service.markFailed(processing.id, 'THUMBNAIL_FAILED');
    await service.markFailed(ready.id, 'THUMBNAIL_FAILED');

    expect(
      await videoRepository.findOneByOrFail({ id: processing.id }),
    ).toMatchObject({
      status: VideoStatus.ERROR,
      processing_error: 'THUMBNAIL_FAILED',
    });
    expect(
      await videoRepository.findOneByOrFail({ id: ready.id }),
    ).toMatchObject({ status: VideoStatus.READY, processing_error: null });
  });
  describe('reconcileStuck', () => {
    async function ageVideo(id: string, ageMs: number): Promise<void> {
      await dataSource.query(
        `UPDATE "videos" SET "updated_at" = now() - ($2 || ' milliseconds')::interval WHERE "id" = $1`,
        [id, ageMs],
      );
    }

    it('should re-enqueue a video stuck in processing longer than the threshold', async () => {
      const video = await seedVideo(VideoStatus.PROCESSING);
      await ageVideo(video.id, STUCK_AFTER_MS * 2);

      const count = await service.reconcileStuck();

      expect(count).toBe(1);
      expect((await queue.getJob(`process-${video.id}`))?.data).toEqual({
        videoId: video.id,
      });
    });

    it('should leave recent processing videos and videos in other states alone', async () => {
      const recent = await seedVideo(VideoStatus.PROCESSING);
      const ready = await seedVideo(VideoStatus.READY);
      await ageVideo(ready.id, STUCK_AFTER_MS * 2);

      const count = await service.reconcileStuck();

      expect(count).toBe(0);
      expect(await queue.getJob(`process-${recent.id}`)).toBeUndefined();
      expect(await queue.getJob(`process-${ready.id}`)).toBeUndefined();
    });

    it('should not duplicate a job that is still in the queue', async () => {
      const video = await seedVideo(VideoStatus.PROCESSING);
      await ageVideo(video.id, STUCK_AFTER_MS * 2);

      await service.reconcileStuck();
      await service.reconcileStuck();

      const counts = await queue.getJobCounts('waiting', 'delayed', 'active');
      expect(counts.waiting + counts.delayed + counts.active).toBe(1);
    });
  });
});
