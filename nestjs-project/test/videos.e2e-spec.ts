import type { CreateVideoResponseDto } from '../src/videos/dto/create-video-response.dto';
import type { PlaybackUrlResponseDto } from '../src/videos/dto/playback-url-response.dto';
import type { VideoResponseDto } from '../src/videos/dto/video-response.dto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { ThrottlerStorageService } from '@nestjs/throttler';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { CONFIG_MODULE_OPTIONS } from '../src/config/config-module.options';
import databaseConfig from '../src/config/database.config';
import { buildTypeOrmOptions } from '../src/database/typeorm-options.factory';
import { MediaModule } from '../src/media/media.module';
import { QueueModule } from '../src/queue/queue.module';
import { StorageModule } from '../src/storage/storage.module';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { openVideoProcessingQueue } from '../src/test/queue';
import { clearTestBuckets, createTestS3Client } from '../src/test/storage';
import { Channel } from '../src/channels/entities/channel.entity';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';
import { VideoProcessingQueue } from '../src/videos/processing/video-processing.queue';
import { VideoProcessingService } from '../src/videos/processing/video-processing.service';
import {
  E2E_QUEUE_PREFIX,
  createE2eApp,
  registerConfirmAndLogin,
  bodyOf,
} from './support/e2e-app';

const SAMPLE = resolve(__dirname, 'fixtures/sample.mp4');

/**
 * Full video flow against the real Compose services: direct-to-storage
 * multipart upload → completion → processing with real ffmpeg → read,
 * stream (206) and download. The processor is invoked directly instead of
 * waiting for queue delivery (phase-03-videos/TD-13).
 */
describe('Videos — full flow (e2e)', () => {
  let app: INestApplication<App>;
  let worker: TestingModule;
  let processing: VideoProcessingService;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let s3: S3Client;
  let queue: Queue;
  let userCounter = 0;

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    throttlerStorage = e2e.throttlerStorage;
    dataSource = e2e.moduleFixture.get(DataSource);

    // Worker-side services only (no BullMQ consumer), on the same test buckets/prefix.
    worker = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(CONFIG_MODULE_OPTIONS),
        TypeOrmModule.forRootAsync({
          inject: [databaseConfig.KEY],
          useFactory: buildTypeOrmOptions,
        }),
        TypeOrmModule.forFeature([Video, Channel, User]),
        StorageModule,
        MediaModule,
        QueueModule,
      ],
      providers: [VideoProcessingService, VideoProcessingQueue],
    }).compile();
    processing = worker.get(VideoProcessingService);

    s3 = createTestS3Client();
    queue = openVideoProcessingQueue(E2E_QUEUE_PREFIX);
  }, 30000);

  afterAll(async () => {
    await clearTestBuckets(s3);
    await queue.obliterate({ force: true });
    await queue.close();
    s3.destroy();
    await worker.close();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await clearTestBuckets(s3);
    await queue.obliterate({ force: true });
    throttlerStorage.storage.clear();
  });

  async function loginNewUser(): Promise<string> {
    return registerConfirmAndLogin(
      app,
      `videos_flow_${++userCounter}@example.com`,
    );
  }

  /** Runs the whole upload handshake for the sample fixture; returns ids from POST /videos. */
  async function uploadSample(
    token: string,
  ): Promise<{ id: string; publicId: string }> {
    const payload = await readFile(SAMPLE);
    const created = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Sample',
        fileName: 'sample.mp4',
        contentType: 'video/mp4',
        fileSize: payload.length,
      })
      .expect(201);

    const parts: { partNumber: number; etag: string }[] = [];
    for (const part of bodyOf<CreateVideoResponseDto>(created).parts) {
      const start =
        (part.partNumber - 1) *
        bodyOf<CreateVideoResponseDto>(created).partSize;
      const put = await fetch(part.url, {
        method: 'PUT',
        body: Uint8Array.from(
          payload.subarray(
            start,
            start + bodyOf<CreateVideoResponseDto>(created).partSize,
          ),
        ),
      });
      expect(put.status).toBe(200);
      parts.push({
        partNumber: part.partNumber,
        etag: put.headers.get('etag')!,
      });
    }

    await request(app.getHttpServer())
      .post(
        `/videos/${bodyOf<CreateVideoResponseDto>(created).id}/upload/complete`,
      )
      .set('Authorization', `Bearer ${token}`)
      .send({ parts })
      .expect(200);

    return {
      id: bodyOf<CreateVideoResponseDto>(created).id,
      publicId: bodyOf<CreateVideoResponseDto>(created).publicId,
    };
  }

  it('uploads, processes and serves a video end to end', async () => {
    const token = await loginNewUser();
    const { id, publicId } = await uploadSample(token);

    // Completion enqueued the job; run the processor as the worker would.
    expect((await queue.getJob(`process-${id}`))?.data).toEqual({
      videoId: id,
    });
    const before = await request(app.getHttpServer())
      .get(`/videos/${publicId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(bodyOf<VideoResponseDto>(before).status).toBe('processing');
    await request(app.getHttpServer())
      .get(`/videos/${publicId}/stream`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);

    await processing.process(id);

    const video = await request(app.getHttpServer())
      .get(`/videos/${publicId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(video.body).toMatchObject({
      id,
      publicId,
      status: 'ready',
      width: 320,
      height: 240,
    });
    expect(bodyOf<VideoResponseDto>(video).durationSeconds).toBeCloseTo(2.0, 1);
    expect(bodyOf<VideoResponseDto>(video).thumbnailUrl).toEqual(
      expect.any(String),
    );
    const thumb = await fetch(bodyOf<VideoResponseDto>(video).thumbnailUrl!);
    expect(thumb.headers.get('content-type')).toBe('image/jpeg');

    const stream = await request(app.getHttpServer())
      .get(`/videos/${publicId}/stream`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const ranged = await fetch(bodyOf<PlaybackUrlResponseDto>(stream).url, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(1024);

    const download = await request(app.getHttpServer())
      .get(`/videos/${publicId}/download`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const file = await fetch(bodyOf<PlaybackUrlResponseDto>(download).url);
    expect(file.headers.get('content-disposition')).toBe(
      'attachment; filename="sample.mp4"',
    );
    expect(Buffer.from(await file.arrayBuffer())).toEqual(
      await readFile(SAMPLE),
    );
  });

  it('gives every video a distinct public id that resolves to that video', async () => {
    const token = await loginNewUser();
    const first = await uploadSample(token);
    const second = await uploadSample(token);

    expect(first.publicId).not.toBe(second.publicId);
    for (const { id, publicId } of [first, second]) {
      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(bodyOf<VideoResponseDto>(res).id).toBe(id);
    }
  });

  it('keeps videos private to their channel in this phase', async () => {
    const ownerToken = await loginNewUser();
    const { publicId } = await uploadSample(ownerToken);
    const otherToken = await loginNewUser();

    await request(app.getHttpServer()).get(`/videos/${publicId}`).expect(401);
    await request(app.getHttpServer())
      .get(`/videos/${publicId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/videos/${publicId}/download`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
  });
});
