import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import type { PlaybackUrlResponseDto } from '../src/videos/dto/playback-url-response.dto';
import type { VideoResponseDto } from '../src/videos/dto/video-response.dto';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { ThrottlerStorageService } from '@nestjs/throttler';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../src/channels/entities/channel.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  TEST_BUCKETS,
  clearTestBuckets,
  createTestS3Client,
} from '../src/test/storage';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { generatePublicId } from '../src/videos/public-id.util';
import {
  createE2eApp,
  registerConfirmAndLogin,
  bodyOf,
} from './support/e2e-app';

const SAMPLE = resolve(__dirname, 'fixtures/sample.mp4');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

// Generated from specs/videos-read.plan.md (SI-03.10).
describe('videos-read', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let s3: S3Client;
  let ownerToken: string;
  let otherToken: string;
  let ready: Video;
  let processing: Video;
  let userCounter = 0;

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    throttlerStorage = e2e.throttlerStorage;
    dataSource = e2e.moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    s3 = createTestS3Client();
  });

  afterAll(async () => {
    await clearTestBuckets(s3);
    s3.destroy();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await clearTestBuckets(s3);
    throttlerStorage.storage.clear();

    const ownerEmail = `videos_read_${++userCounter}@example.com`;
    ownerToken = await registerConfirmAndLogin(app, ownerEmail);
    otherToken = await registerConfirmAndLogin(
      app,
      `videos_read_${++userCounter}@example.com`,
    );

    const owner = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email: ownerEmail });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: owner.id });

    ready = await seedVideo(channel.id, VideoStatus.READY);
    processing = await seedVideo(channel.id, VideoStatus.PROCESSING);
  });

  async function seedVideo(
    channelId: string,
    status: VideoStatus,
  ): Promise<Video> {
    const id = randomUUID();
    const source = await readFile(SAMPLE);
    await s3.send(
      new PutObjectCommand({
        Bucket: TEST_BUCKETS.videos,
        Key: `${id}/source`,
        Body: source,
        ContentType: 'video/mp4',
      }),
    );
    const isReady = status === VideoStatus.READY;
    if (isReady) {
      await s3.send(
        new PutObjectCommand({
          Bucket: TEST_BUCKETS.thumbnails,
          Key: `${id}/default.jpg`,
          Body: JPEG,
          ContentType: 'image/jpeg',
        }),
      );
    }
    await videoRepository.save({
      id,
      channel_id: channelId,
      public_id: generatePublicId(),
      title: 'Sample',
      original_filename: 'sample.mp4',
      content_type: 'video/mp4',
      declared_size_bytes: String(source.length),
      size_bytes: String(source.length),
      source_key: `${id}/source`,
      status,
      thumbnail_key: isReady ? `${id}/default.jpg` : null,
      duration_seconds: isReady ? 2 : null,
      width: isReady ? 320 : null,
      height: isReady ? 240 : null,
      processed_at: isReady ? new Date() : null,
    });
    return videoRepository.findOneByOrFail({ id });
  }

  // 1. Leitura, streaming e download de vídeo pronto

  test('le-video-pronto-pela-url-unica', async () => {
    const res = await request(app.getHttpServer())
      .get(`/videos/${ready.public_id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(res.body).toMatchObject({
      publicId: ready.public_id,
      status: 'ready',
      publicationStatus: 'draft',
      durationSeconds: 2,
      width: 320,
      height: 240,
    });
    expect(bodyOf<VideoResponseDto>(res).thumbnailUrl).toEqual(
      expect.any(String),
    );

    const thumb = await fetch(bodyOf<VideoResponseDto>(res).thumbnailUrl!);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/jpeg');
  });

  test('stream-entrega-url-com-range-206', async () => {
    const res = await request(app.getHttpServer())
      .get(`/videos/${ready.public_id}/stream`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(bodyOf<PlaybackUrlResponseDto>(res).url).toEqual(expect.any(String));
    expect(
      new Date(bodyOf<PlaybackUrlResponseDto>(res).expiresAt).getTime(),
    ).toBeGreaterThan(Date.now());

    const ranged = await fetch(bodyOf<PlaybackUrlResponseDto>(res).url, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(1024);
    expect(ranged.headers.get('content-range')).toMatch(/^bytes 0-1023\//);
  });

  test('download-entrega-url-com-attachment', async () => {
    const res = await request(app.getHttpServer())
      .get(`/videos/${ready.public_id}/download`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(bodyOf<PlaybackUrlResponseDto>(res).expiresAt).toEqual(
      expect.any(String),
    );

    const file = await fetch(bodyOf<PlaybackUrlResponseDto>(res).url);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toBe(
      'attachment; filename="sample.mp4"',
    );
  });

  // 2. Estado, autorização e validação

  test('stream-de-video-nao-pronto-retorna-409', async () => {
    const res = await request(app.getHttpServer())
      .get(`/videos/${processing.public_id}/stream`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(409);

    expect(bodyOf<ApiErrorEnvelope>(res).error).toBe('VIDEO_NOT_READY');
  });

  test('outro-canal-ou-inexistente-retorna-404', async () => {
    const other = await request(app.getHttpServer())
      .get(`/videos/${ready.public_id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    expect(bodyOf<ApiErrorEnvelope>(other).error).toBe('VIDEO_NOT_FOUND');

    await request(app.getHttpServer())
      .get(`/videos/${ready.public_id}/download`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);

    const missing = await request(app.getHttpServer())
      .get('/videos/ZZZZZZZZZZZ')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
    expect(bodyOf<ApiErrorEnvelope>(missing).error).toBe('VIDEO_NOT_FOUND');
  });

  test('public-id-invalido-e-anonimo', async () => {
    await request(app.getHttpServer())
      .get('/videos/abc')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);

    await request(app.getHttpServer())
      .get(`/videos/${ready.public_id}`)
      .expect(401);
  });
});
