import { Test } from '@nestjs/testing';
import type { Job } from 'bullmq';
import type { ProcessVideoJobData } from './video-processing.constants';
import { VideoProcessingConsumer } from './video-processing.consumer';
import {
  ProcessingStageError,
  VideoProcessingService,
} from './video-processing.service';

function buildJob(
  overrides: Partial<Job<ProcessVideoJobData>> = {},
): Job<ProcessVideoJobData> {
  return {
    name: 'process',
    data: { videoId: 'video-1' },
    attemptsMade: 3,
    opts: { attempts: 3 },
    ...overrides,
  } as Job<ProcessVideoJobData>;
}

describe('VideoProcessingConsumer', () => {
  let consumer: VideoProcessingConsumer;
  const processingService = {
    process: jest.fn(),
    markFailed: jest.fn(),
    reconcileStuck: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingConsumer,
        { provide: VideoProcessingService, useValue: processingService },
      ],
    }).compile();
    consumer = module.get(VideoProcessingConsumer);
  });

  describe('process', () => {
    it('should route process jobs to VideoProcessingService.process', async () => {
      await consumer.process(buildJob());

      expect(processingService.process).toHaveBeenCalledWith('video-1');
    });

    it('should route reconcile jobs to VideoProcessingService.reconcileStuck', async () => {
      await consumer.process(
        buildJob({ name: 'reconcile', data: {} as never }),
      );

      expect(processingService.reconcileStuck).toHaveBeenCalledTimes(1);
      expect(processingService.process).not.toHaveBeenCalled();
    });

    it('should reject unknown job names', async () => {
      await expect(
        consumer.process(buildJob({ name: 'unknown' })),
      ).rejects.toThrow('Unknown video-processing job "unknown"');
    });
  });

  describe('onFailed', () => {
    it('should not touch the video while attempts remain', async () => {
      await consumer.onFailed(
        buildJob({ attemptsMade: 1 }),
        new ProcessingStageError('THUMBNAIL_FAILED', new Error('boom')),
      );

      expect(processingService.markFailed).not.toHaveBeenCalled();
    });

    it('should mark the video with the failing stage reason on the last attempt', async () => {
      await consumer.onFailed(
        buildJob(),
        new ProcessingStageError('THUMBNAIL_FAILED', new Error('boom')),
      );

      expect(processingService.markFailed).toHaveBeenCalledWith(
        'video-1',
        'THUMBNAIL_FAILED',
      );
    });

    it('should default to PROBE_FAILED for failures without a stage', async () => {
      await consumer.onFailed(buildJob(), new Error('presign failed'));

      expect(processingService.markFailed).toHaveBeenCalledWith(
        'video-1',
        'PROBE_FAILED',
      );
    });

    it('should ignore jobs that are not process jobs', async () => {
      await consumer.onFailed(buildJob({ name: 'reconcile' }), new Error('x'));

      expect(processingService.markFailed).not.toHaveBeenCalled();
    });

    it('should not throw when marking the video as failed fails', async () => {
      processingService.markFailed.mockRejectedValueOnce(new Error('db down'));

      await expect(
        consumer.onFailed(buildJob(), new Error('x')),
      ).resolves.toBeUndefined();
    });
  });
});
