import type { CreateVideoResponseDto } from '../src/videos/dto/create-video-response.dto';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import type { INestApplication } from '@nestjs/common';
import type { ThrottlerStorageService } from '@nestjs/throttler';
import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { openVideoProcessingQueue } from '../src/test/queue';
import {
  TEST_BUCKETS,
  clearTestBuckets,
  createTestS3Client,
} from '../src/test/storage';
import { Video } from '../src/videos/entities/video.entity';
import {
  E2E_QUEUE_PREFIX,
  createE2eApp,
  registerConfirmAndLogin,
  bodyOf,
} from './support/e2e-app';

const MIB = 1024 * 1024;
// S3/MinIO minimum part size: lets a 6MiB payload span 2 parts (5MiB + 1MiB).
const PART_SIZE = 5 * MIB;

interface Part {
  partNumber: number;
  etag: string;
}

// Generated from specs/videos-upload-complete.plan.md (SI-03.6).
describe('videos-upload-complete', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let s3: S3Client;
  let queue: Queue;
  let ownerToken: string;
  let userCounter = 0;

  beforeAll(async () => {
    process.env.STORAGE_UPLOAD_PART_SIZE_BYTES = String(PART_SIZE);
    const e2e = await createE2eApp();
    app = e2e.app;
    throttlerStorage = e2e.throttlerStorage;
    dataSource = e2e.moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    s3 = createTestS3Client();
    queue = openVideoProcessingQueue(E2E_QUEUE_PREFIX);
  });

  afterAll(async () => {
    await clearTestBuckets(s3);
    await queue.obliterate({ force: true });
    await queue.close();
    s3.destroy();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await clearTestBuckets(s3);
    await queue.obliterate({ force: true });
    throttlerStorage.storage.clear();
    ownerToken = await loginNewUser();
  });

  async function loginNewUser(): Promise<string> {
    return registerConfirmAndLogin(
      app,
      `videos_complete_${++userCounter}@example.com`,
    );
  }

  /** Creates a video and PUTs the given chunks to its presigned part URLs. */
  async function createAndUpload(
    token: string,
    declaredSize: number,
    chunks: Buffer[],
  ): Promise<{
    id: string;
    publicId: string;
    parts: Part[];
    partUrls: string[];
  }> {
    const created = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Upload complete',
        fileName: 'complete.mp4',
        contentType: 'video/mp4',
        fileSize: declaredSize,
      })
      .expect(201);

    const parts: Part[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const put = await fetch(
        bodyOf<CreateVideoResponseDto>(created).parts[i].url,
        {
          method: 'PUT',
          body: Uint8Array.from(chunks[i]),
        },
      );
      expect(put.status).toBe(200);
      parts.push({ partNumber: i + 1, etag: put.headers.get('etag')! });
    }
    return {
      id: bodyOf<CreateVideoResponseDto>(created).id,
      publicId: bodyOf<CreateVideoResponseDto>(created).publicId,
      parts,
      partUrls: bodyOf<CreateVideoResponseDto>(created).parts.map(
        (p: { url: string }) => p.url,
      ),
    };
  }

  function sixMibChunks(): Buffer[] {
    return [Buffer.alloc(PART_SIZE, 1), Buffer.alloc(MIB, 2)];
  }

  // 1. Conclusão do upload

  test('conclui-e-enfileira-processamento', async () => {
    const video = await createAndUpload(ownerToken, 6 * MIB, sixMibChunks());

    const res = await request(app.getHttpServer())
      .post(`/videos/${video.id}/upload/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ parts: video.parts })
      .expect(200);

    expect(res.body).toEqual({
      id: video.id,
      publicId: video.publicId,
      status: 'processing',
    });
    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row).toMatchObject({
      status: 'processing',
      size_bytes: String(6 * MIB),
      upload_id: null,
    });
    const job = await queue.getJob(`process-${video.id}`);
    expect(job?.data).toEqual({ videoId: video.id });
  });

  test('divergencia-de-tamanho-marca-erro-e-apaga-objeto', async () => {
    // Declares 7MiB (2 parts) but only 6MiB is actually sent.
    const video = await createAndUpload(ownerToken, 7 * MIB, sixMibChunks());

    const res = await request(app.getHttpServer())
      .post(`/videos/${video.id}/upload/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ parts: video.parts })
      .expect(422);

    expect(bodyOf<ApiErrorEnvelope>(res).error).toBe('UPLOAD_SIZE_MISMATCH');
    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row).toMatchObject({
      status: 'error',
      processing_error: 'UPLOAD_SIZE_MISMATCH',
    });
    const { Contents = [] } = await s3.send(
      new ListObjectsV2Command({ Bucket: TEST_BUCKETS.videos }),
    );
    expect(Contents.map((o) => o.Key)).not.toContain(`${video.id}/source`);
    expect(await queue.getJob(`process-${video.id}`)).toBeUndefined();
  });

  test('parte-faltando-mantem-uploading', async () => {
    // 2 parts announced; only part 1 is sent.
    const video = await createAndUpload(ownerToken, 6 * MIB, [
      Buffer.alloc(PART_SIZE, 1),
    ]);
    expect(video.partUrls.length).toBeGreaterThanOrEqual(2);
    const uploadIdBefore = (
      await videoRepository.findOneByOrFail({ id: video.id })
    ).upload_id;

    const res = await request(app.getHttpServer())
      .post(`/videos/${video.id}/upload/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        parts: [...video.parts, { partNumber: 2, etag: '"made-up-etag"' }],
      })
      .expect(422);

    expect(bodyOf<ApiErrorEnvelope>(res).error).toBe(
      'UPLOAD_COMPLETION_FAILED',
    );
    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe('uploading');
    expect(row.upload_id).toBe(uploadIdBefore);
  });

  // 2. Estado, autorização e validação

  test('conclusao-repetida-retorna-409', async () => {
    const video = await createAndUpload(ownerToken, 6 * MIB, sixMibChunks());
    await request(app.getHttpServer())
      .post(`/videos/${video.id}/upload/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ parts: video.parts })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/videos/${video.id}/upload/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ parts: video.parts })
      .expect(409);

    expect(bodyOf<ApiErrorEnvelope>(res).error).toBe('INVALID_VIDEO_STATE');
  });

  test('outro-canal-recebe-404', async () => {
    const video = await createAndUpload(ownerToken, 6 * MIB, sixMibChunks());
    const otherToken = await loginNewUser();

    const res = await request(app.getHttpServer())
      .post(`/videos/${video.id}/upload/complete`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ parts: video.parts })
      .expect(404);

    expect(bodyOf<ApiErrorEnvelope>(res).error).toBe('VIDEO_NOT_FOUND');
    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe('uploading');
  });

  test('id-nao-uuid-retorna-400', async () => {
    await request(app.getHttpServer())
      .post('/videos/not-a-uuid/upload/complete')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ parts: [{ partNumber: 1, etag: '"etag"' }] })
      .expect(400);
  });
});
