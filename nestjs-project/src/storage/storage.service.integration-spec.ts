import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import type { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import {
  clearTestBuckets,
  createTestS3Client,
  useTestStorageBuckets,
} from '../test/storage';
import { STORAGE_BUCKETS } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService, type UploadedPart } from './storage.service';

const MIB = 1024 * 1024;
const PART_SIZE = 5 * MIB; // S3/MinIO minimum for every part except the last
const TTL_SECONDS = 300;

function buildPayload(sizeBytes: number): Buffer {
  const payload = Buffer.alloc(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) payload[i] = i % 251;
  return payload;
}

async function uploadParts(
  storage: StorageService,
  key: string,
  uploadId: string,
  payload: Buffer,
): Promise<UploadedPart[]> {
  const partCount = Math.ceil(payload.length / PART_SIZE);
  const parts = await storage.presignUploadParts(
    key,
    uploadId,
    partCount,
    TTL_SECONDS,
  );
  const uploaded: UploadedPart[] = [];
  for (const part of parts) {
    const start = (part.partNumber - 1) * PART_SIZE;
    const res = await fetch(part.url, {
      method: 'PUT',
      body: Uint8Array.from(payload.subarray(start, start + PART_SIZE)),
    });
    expect(res.status).toBe(200);
    uploaded.push({
      partNumber: part.partNumber,
      etag: res.headers.get('etag')!,
    });
  }
  return uploaded;
}

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let storage: StorageService;
  let s3: S3Client;

  beforeAll(async () => {
    useTestStorageBuckets();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = module.get(StorageService);
    s3 = createTestS3Client();
  });

  beforeEach(async () => {
    await clearTestBuckets(s3);
  });

  afterAll(async () => {
    await clearTestBuckets(s3);
    s3.destroy();
    await module.close();
  });

  it('should accept PUTs on presigned part URLs and return an ETag', async () => {
    const key = 'storage-spec/put/source';
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const [part] = await storage.presignUploadParts(
      key,
      uploadId,
      1,
      TTL_SECONDS,
    );

    const res = await fetch(part.url, {
      method: 'PUT',
      body: Uint8Array.from(buildPayload(PART_SIZE)),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeTruthy();
  });

  it('should complete a multipart upload into an object whose size is the sum of its parts', async () => {
    const key = 'storage-spec/complete/source';
    const payload = buildPayload(6 * MIB);
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const parts = await uploadParts(storage, key, uploadId, payload);

    await storage.completeMultipartUpload(key, uploadId, [...parts].reverse());

    const head = await storage.headObject(STORAGE_BUCKETS.VIDEOS, key);
    expect(head).toEqual({
      contentLength: payload.length,
      contentType: 'video/mp4',
    });
  });

  it('should serve 206 Partial Content for a Range request on a presigned GET', async () => {
    const key = 'storage-spec/range/source';
    await storage.putObject(
      STORAGE_BUCKETS.VIDEOS,
      key,
      buildPayload(1024),
      'video/mp4',
    );
    const url = await storage.presignGet(
      STORAGE_BUCKETS.VIDEOS,
      key,
      TTL_SECONDS,
    );

    const res = await fetch(url, { headers: { Range: 'bytes=0-99' } });

    expect(res.status).toBe(206);
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it('should sign Content-Disposition into a presigned download URL', async () => {
    const key = 'storage-spec/download/source';
    await storage.putObject(
      STORAGE_BUCKETS.VIDEOS,
      key,
      buildPayload(16),
      'video/mp4',
    );
    const url = await storage.presignGet(
      STORAGE_BUCKETS.VIDEOS,
      key,
      TTL_SECONDS,
      {
        contentDisposition: 'attachment; filename="my-video.mp4"',
      },
    );

    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="my-video.mp4"',
    );
  });

  it('should leave no object behind after aborting a multipart upload', async () => {
    const key = 'storage-spec/abort/source';
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    await uploadParts(storage, key, uploadId, buildPayload(PART_SIZE));

    await storage.abortMultipartUpload(key, uploadId);

    expect(await storage.headObject(STORAGE_BUCKETS.VIDEOS, key)).toBeNull();
  });

  it('should write thumbnails to the thumbnails bucket and delete objects', async () => {
    const key = 'storage-spec/thumb/default.jpg';
    await storage.putObject(
      STORAGE_BUCKETS.THUMBNAILS,
      key,
      Buffer.from([0xff, 0xd8]),
      'image/jpeg',
    );

    expect(await storage.headObject(STORAGE_BUCKETS.THUMBNAILS, key)).toEqual({
      contentLength: 2,
      contentType: 'image/jpeg',
    });
    expect(await storage.headObject(STORAGE_BUCKETS.VIDEOS, key)).toBeNull();

    await storage.deleteObject(STORAGE_BUCKETS.THUMBNAILS, key);
    expect(
      await storage.headObject(STORAGE_BUCKETS.THUMBNAILS, key),
    ).toBeNull();
  });
});
