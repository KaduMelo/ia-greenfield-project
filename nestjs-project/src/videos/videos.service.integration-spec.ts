import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  TEST_BUCKETS,
  clearTestBuckets,
  createTestS3Client,
  useTestStorageBuckets,
} from '../test/storage';
import { openVideoProcessingQueue, useTestQueuePrefix } from '../test/queue';
import { User } from '../users/entities/user.entity';
import {
  Video,
  VideoPublicationStatus,
  VideoStatus,
} from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let s3: S3Client;
  let queue: Queue;
  let counter = 0;

  beforeAll(async () => {
    useTestStorageBuckets();
    useTestQueuePrefix();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
    service = module.get(VideosService);
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

  async function createUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const n = ++counter;
    const user = await dataSource.getRepository(User).save({
      email: `videos_svc_${n}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `Channel ${n}`,
      nickname: `videos_svc_${n}`,
      user_id: user.id,
    });
    return { user, channel };
  }

  describe('createUpload', () => {
    it('should persist an uploading draft and start a multipart upload in the videos bucket', async () => {
      const { user, channel } = await createUserWithChannel();

      const result = await service.createUpload(user.id, {
        title: 'Integration video',
        fileName: 'integration.mp4',
        contentType: 'video/mp4',
        fileSize: 6 * 1024 * 1024,
      });

      const row = await videoRepository.findOneByOrFail({ id: result.id });
      expect(row).toMatchObject({
        channel_id: channel.id,
        public_id: result.publicId,
        status: VideoStatus.UPLOADING,
        publication_status: VideoPublicationStatus.DRAFT,
        upload_id: result.uploadId,
        source_key: `${result.id}/source`,
        declared_size_bytes: String(6 * 1024 * 1024),
        original_filename: 'integration.mp4',
      });

      const { Uploads = [] } = await s3.send(
        new ListMultipartUploadsCommand({ Bucket: TEST_BUCKETS.videos }),
      );
      expect(Uploads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Key: `${result.id}/source`,
            UploadId: result.uploadId,
          }),
        ]),
      );
    });

    it('should return presigned part URLs that accept a direct PUT to storage', async () => {
      const { user } = await createUserWithChannel();
      const result = await service.createUpload(user.id, {
        title: 'Parts',
        fileName: 'parts.mp4',
        contentType: 'video/mp4',
        fileSize: 1024,
      });

      const res = await fetch(result.parts[0].url, {
        method: 'PUT',
        body: Buffer.alloc(1024, 7),
      });

      expect(result.parts).toHaveLength(1);
      expect(res.status).toBe(200);
      expect(res.headers.get('etag')).toBeTruthy();
    });
  });
  describe('completeUpload', () => {
    async function startAndUpload(
      userId: string,
      declaredSize: number,
      payload: Buffer,
    ) {
      const created = await service.createUpload(userId, {
        title: 'Complete',
        fileName: 'complete.mp4',
        contentType: 'video/mp4',
        fileSize: declaredSize,
      });
      const put = await fetch(created.parts[0].url, {
        method: 'PUT',
        body: Uint8Array.from(payload),
      });
      return {
        created,
        parts: [{ partNumber: 1, etag: put.headers.get('etag')! }],
      };
    }

    it('should complete the upload, store the real size and enqueue the process job', async () => {
      const { user } = await createUserWithChannel();
      const payload = Buffer.alloc(1024 * 1024, 3);
      const { created, parts } = await startAndUpload(
        user.id,
        payload.length,
        payload,
      );

      const result = await service.completeUpload(user.id, created.id, parts);

      expect(result).toEqual({
        id: created.id,
        publicId: created.publicId,
        status: VideoStatus.PROCESSING,
      });
      const row = await videoRepository.findOneByOrFail({ id: created.id });
      expect(row).toMatchObject({
        status: VideoStatus.PROCESSING,
        size_bytes: String(payload.length),
        upload_id: null,
      });
      const job = await queue.getJob(`process-${created.id}`);
      expect(job?.data).toEqual({ videoId: created.id });
    });

    it('should delete the object and mark the video as error when the real size differs', async () => {
      const { user } = await createUserWithChannel();
      const payload = Buffer.alloc(1024 * 1024, 4);
      const { created, parts } = await startAndUpload(
        user.id,
        payload.length + 1,
        payload,
      );

      await expect(
        service.completeUpload(user.id, created.id, parts),
      ).rejects.toThrow('Uploaded size does not match the declared file size');

      const row = await videoRepository.findOneByOrFail({ id: created.id });
      expect(row).toMatchObject({
        status: VideoStatus.ERROR,
        processing_error: 'UPLOAD_SIZE_MISMATCH',
        upload_id: null,
      });
      const { Contents = [] } = await s3.send(
        new ListObjectsV2Command({ Bucket: TEST_BUCKETS.videos }),
      );
      expect(Contents.map((o) => o.Key)).not.toContain(`${created.id}/source`);
      expect(await queue.getJob(`process-${created.id}`)).toBeUndefined();
    });
  });
  describe('getVideo / getPlaybackUrl', () => {
    async function seedReadyVideo(userId: string, channelId: string) {
      const id = randomUUID();
      const payload = Buffer.alloc(4096, 9);
      await s3.send(
        new PutObjectCommand({
          Bucket: TEST_BUCKETS.videos,
          Key: `${id}/source`,
          Body: payload,
          ContentType: 'video/mp4',
        }),
      );
      await videoRepository.save({
        id,
        channel_id: channelId,
        public_id: generatePublicId(),
        title: 'Ready',
        original_filename: 'sample.mp4',
        content_type: 'video/mp4',
        declared_size_bytes: String(payload.length),
        size_bytes: String(payload.length),
        source_key: `${id}/source`,
        status: VideoStatus.READY,
      });
      return videoRepository.findOneByOrFail({ id });
    }

    it('should return a stream URL that the storage answers with 206 for a Range request', async () => {
      const { user, channel } = await createUserWithChannel();
      const video = await seedReadyVideo(user.id, channel.id);

      const { url } = await service.getPlaybackUrl(
        user.id,
        video.public_id,
        'stream',
      );
      const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });

      expect(res.status).toBe(206);
      expect((await res.arrayBuffer()).byteLength).toBe(1024);
    });

    it('should return a download URL that serves the file as an attachment', async () => {
      const { user, channel } = await createUserWithChannel();
      const video = await seedReadyVideo(user.id, channel.id);

      const { url } = await service.getPlaybackUrl(
        user.id,
        video.public_id,
        'download',
      );
      const res = await fetch(url);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe(
        'attachment; filename="sample.mp4"',
      );
    });

    it('should resolve the video by its public id with metadata', async () => {
      const { user, channel } = await createUserWithChannel();
      const video = await seedReadyVideo(user.id, channel.id);

      const result = await service.getVideo(user.id, video.public_id);

      expect(result).toMatchObject({
        id: video.id,
        publicId: video.public_id,
        status: 'ready',
        sizeBytes: 4096,
        thumbnailUrl: null,
      });
    });
  });
});
