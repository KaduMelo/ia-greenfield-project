import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import type { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { STORAGE_BUCKETS } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  clearTestBuckets,
  createTestS3Client,
  useTestStorageBuckets,
} from '../test/storage';
import {
  MediaCommandError,
  MediaProbeService,
  NoVideoStreamError,
} from './media-probe.service';
import { MediaModule } from './media.module';

const FIXTURES = resolve(__dirname, '../../test/fixtures');
const SAMPLE = resolve(FIXTURES, 'sample.mp4');
const AUDIO_ONLY = resolve(FIXTURES, 'audio-only.m4a');

describe('MediaProbeService (integration)', () => {
  let module: TestingModule;
  let media: MediaProbeService;
  let storage: StorageService;
  let s3: S3Client;

  beforeAll(async () => {
    useTestStorageBuckets();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        MediaModule,
        StorageModule,
      ],
    }).compile();
    media = module.get(MediaProbeService);
    storage = module.get(StorageService);
    s3 = createTestS3Client();
    await clearTestBuckets(s3);
  });

  afterAll(async () => {
    await clearTestBuckets(s3);
    s3.destroy();
    await module.close();
  });

  it('should have ffprobe available in the container', () => {
    expect(execFileSync('ffprobe', ['-version']).toString()).toMatch(
      /^ffprobe version/,
    );
  });

  it('should probe duration, dimensions and format of the sample video', async () => {
    const result = await media.probe(SAMPLE);

    expect(result.durationSeconds).toBeCloseTo(2.0, 1);
    expect(result.width).toBe(320);
    expect(result.height).toBe(240);
    expect(result.formatName).toContain('mp4');
    expect(result.raw).toHaveProperty('streams');
  });

  it('should reject an input without a video stream', async () => {
    await expect(media.probe(AUDIO_ONLY)).rejects.toThrow(NoVideoStreamError);
  });

  it('should surface a MediaCommandError for an unreadable input', async () => {
    await expect(media.probe(resolve(FIXTURES, 'missing.mp4'))).rejects.toThrow(
      MediaCommandError,
    );
  });

  it('should extract a JPEG thumbnail frame', async () => {
    const jpeg = await media.extractThumbnail(SAMPLE, 1);

    expect(jpeg.length).toBeGreaterThan(0);
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('should probe and extract a thumbnail straight from a presigned storage URL', async () => {
    const key = 'media-spec/sample/source';
    await storage.putObject(
      STORAGE_BUCKETS.VIDEOS,
      key,
      await readFile(SAMPLE),
      'video/mp4',
    );
    const url = await storage.presignGet(STORAGE_BUCKETS.VIDEOS, key, 300);

    const remote = await media.probe(url);
    const local = await media.probe(SAMPLE);
    const jpeg = await media.extractThumbnail(url, 1);

    expect(remote).toMatchObject({
      durationSeconds: local.durationSeconds,
      width: local.width,
      height: local.height,
      formatName: local.formatName,
    });
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });
});
