import type { CreateVideoResponseDto } from '../src/videos/dto/create-video-response.dto';
import type { INestApplication } from '@nestjs/common';
import type { ThrottlerStorageService } from '@nestjs/throttler';
import type { S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../src/channels/entities/channel.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { clearTestBuckets, createTestS3Client } from '../src/test/storage';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';
import {
  createE2eApp,
  registerConfirmAndLogin,
  bodyOf,
} from './support/e2e-app';

// Generated from specs/videos-create.plan.md (SI-03.4).
describe('videos-create', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let s3: S3Client;
  let token: string;
  let userCounter = 0;

  const validBody = {
    title: 'Meu vídeo',
    fileName: 'meu-video.mp4',
    contentType: 'video/mp4',
    fileSize: 200000000,
  };

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
    token = await registerConfirmAndLogin(
      app,
      `videos_create_${++userCounter}@example.com`,
    );
  });

  // 1. Pré-cadastro do vídeo e início do multipart

  test('cria-video-em-rascunho-com-urls-de-parte', async () => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
      .expect(201);

    expect(res.body).toMatchObject({
      status: 'uploading',
      publicationStatus: 'draft',
    });
    expect(bodyOf<CreateVideoResponseDto>(res).id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(bodyOf<CreateVideoResponseDto>(res).publicId).toMatch(
      /^[0-9A-Za-z]{11}$/,
    );
    expect(bodyOf<CreateVideoResponseDto>(res).uploadId).toEqual(
      expect.any(String),
    );
    expect(bodyOf<CreateVideoResponseDto>(res).uploadId).not.toHaveLength(0);
    expect(Number.isInteger(bodyOf<CreateVideoResponseDto>(res).partSize)).toBe(
      true,
    );
    expect(
      new Date(bodyOf<CreateVideoResponseDto>(res).expiresAt).toISOString(),
    ).toBe(bodyOf<CreateVideoResponseDto>(res).expiresAt);
    expect(bodyOf<CreateVideoResponseDto>(res).parts).toHaveLength(
      Math.ceil(
        validBody.fileSize / bodyOf<CreateVideoResponseDto>(res).partSize,
      ),
    );
    bodyOf<CreateVideoResponseDto>(res).parts.forEach(
      (part: { partNumber: number }, i: number) => {
        expect(part.partNumber).toBe(i + 1);
      },
    );

    const row = await videoRepository.findOneByOrFail({
      id: bodyOf<CreateVideoResponseDto>(res).id,
    });
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email: `videos_create_${userCounter}@example.com` });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: user.id });
    expect(row).toMatchObject({
      status: 'uploading',
      publication_status: 'draft',
      upload_id: bodyOf<CreateVideoResponseDto>(res).uploadId,
      source_key: `${bodyOf<CreateVideoResponseDto>(res).id}/source`,
      declared_size_bytes: '200000000',
      channel_id: channel.id,
    });
  });

  test('urls-de-parte-aceitam-put-direto-no-storage', async () => {
    const payload = Buffer.alloc(6 * 1024 * 1024, 1);
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, fileSize: payload.length })
      .expect(201);
    expect(bodyOf<CreateVideoResponseDto>(res).parts.length).toBeGreaterThan(0);

    const put = await fetch(bodyOf<CreateVideoResponseDto>(res).parts[0].url, {
      method: 'PUT',
      body: payload.subarray(0, bodyOf<CreateVideoResponseDto>(res).partSize),
    });

    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBeTruthy();
  });

  // 2. Validação e autenticação

  test('rejeita-content-type-fora-da-allowlist', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, contentType: 'video/avi' })
      .expect(400);

    expect(await videoRepository.count()).toBe(0);
  });

  test('rejeita-arquivo-acima-de-10gb', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, fileSize: 10737418241 })
      .expect(400);

    expect(await videoRepository.count()).toBe(0);
  });

  test('exige-autenticacao', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send(validBody)
      .expect(401);

    expect(await videoRepository.count()).toBe(0);
  });
});
