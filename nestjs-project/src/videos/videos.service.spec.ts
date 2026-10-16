import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { S3ServiceException } from '@aws-sdk/client-s3';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidVideoStateException,
  UploadCompletionFailedException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import {
  Video,
  VideoPublicationStatus,
  VideoStatus,
} from './entities/video.entity';
import { VideoProcessingQueue } from './processing/video-processing.queue';
import { VideosService } from './videos.service';

const PART_SIZE = 64 * 1024 * 1024;

function uniqueViolation(column: string): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error('duplicate key'));
  Object.assign(err, {
    code: '23505',
    detail: `Key (${column})=(x) already exists.`,
  });
  return err;
}

describe('VideosService', () => {
  let service: VideosService;
  const videoRepository = {
    create: jest.fn((fields: Partial<Video>) => fields),
    save: jest.fn(),
    findOneBy: jest.fn(),
    update: jest.fn(),
  };
  const processingQueue = { enqueueProcess: jest.fn() };
  const channelsService = { findByUserId: jest.fn() };
  const storageService = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    presignUploadParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    deleteObject: jest.fn(),
    presignGet: jest.fn(),
  };

  const dto: CreateVideoDto = {
    title: 'My video',
    fileName: 'my-video.mp4',
    contentType: 'video/mp4',
    fileSize: 200_000_000,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    videoRepository.save.mockImplementation((fields: Partial<Video>) =>
      Promise.resolve({
        ...fields,
        publication_status: VideoPublicationStatus.DRAFT,
      }),
    );
    channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
    storageService.createMultipartUpload.mockResolvedValue('upload-1');
    storageService.presignUploadParts.mockImplementation(
      (_key: string, _uploadId: string, count: number) =>
        Promise.resolve(
          Array.from({ length: count }, (_, i) => ({
            partNumber: i + 1,
            url: `https://storage/part-${i + 1}`,
          })),
        ),
    );

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: VideoProcessingQueue, useValue: processingQueue },
        {
          provide: storageConfig.KEY,
          useValue: {
            uploadPartSizeBytes: PART_SIZE,
            uploadUrlTtlSeconds: 3600,
            playbackUrlTtlSeconds: 600,
          },
        },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('createUpload', () => {
    it('should emit exactly ceil(fileSize / partSize) part URLs', async () => {
      const result = await service.createUpload('user-1', dto);

      expect(result.parts).toHaveLength(Math.ceil(dto.fileSize / PART_SIZE));
      expect(result.partSize).toBe(PART_SIZE);
      expect(storageService.presignUploadParts).toHaveBeenCalledWith(
        `${result.id}/source`,
        'upload-1',
        Math.ceil(dto.fileSize / PART_SIZE),
        3600,
      );
    });

    it('should persist the draft in the caller channel with the multipart upload id', async () => {
      const result = await service.createUpload('user-1', dto);

      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: result.id,
          channel_id: 'channel-1',
          upload_id: 'upload-1',
          source_key: `${result.id}/source`,
          declared_size_bytes: '200000000',
          original_filename: 'my-video.mp4',
        }),
      );
      expect(result).toMatchObject({
        status: 'uploading',
        publicationStatus: 'draft',
        uploadId: 'upload-1',
      });
    });

    it('should retry with a new public_id when the generated one collides', async () => {
      videoRepository.save
        .mockRejectedValueOnce(uniqueViolation('public_id'))
        .mockImplementationOnce((fields: Partial<Video>) =>
          Promise.resolve(fields),
        );

      await service.createUpload('user-1', dto);

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      const [first, second] = videoRepository.save.mock.calls.map(
        ([fields]) => (fields as Partial<Video>).public_id,
      );
      expect(first).not.toBe(second);
    });

    it('should give up after 3 public_id collisions and abort the multipart upload', async () => {
      videoRepository.save.mockRejectedValue(uniqueViolation('public_id'));

      await expect(service.createUpload('user-1', dto)).rejects.toThrow(
        QueryFailedError,
      );
      expect(videoRepository.save).toHaveBeenCalledTimes(3);
      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/\/source$/),
        'upload-1',
      );
    });

    it('should abort the multipart upload and not retry when persistence fails for another reason', async () => {
      videoRepository.save.mockRejectedValueOnce(new Error('db down'));

      await expect(service.createUpload('user-1', dto)).rejects.toThrow(
        'db down',
      );
      expect(videoRepository.save).toHaveBeenCalledTimes(1);
      expect(storageService.abortMultipartUpload).toHaveBeenCalledTimes(1);
      expect(storageService.presignUploadParts).not.toHaveBeenCalled();
    });

    it('should fail before touching storage when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValueOnce(null);

      await expect(service.createUpload('user-1', dto)).rejects.toThrow(
        'has no channel',
      );
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });
  });
  describe('completeUpload', () => {
    const parts = [
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 2, etag: '"etag-2"' },
    ];
    const uploadingVideo = {
      id: 'video-1',
      public_id: 'aZ3kQ9xLm2P',
      channel_id: 'channel-1',
      status: VideoStatus.UPLOADING,
      upload_id: 'upload-1',
      source_key: 'video-1/source',
      declared_size_bytes: '6291456',
    };

    function storageRejection(name: string): S3ServiceException {
      return new S3ServiceException({
        name,
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
        message: name,
      });
    }

    beforeEach(() => {
      videoRepository.findOneBy.mockResolvedValue({ ...uploadingVideo });
      videoRepository.update.mockResolvedValue({ affected: 1 });
      storageService.completeMultipartUpload.mockResolvedValue(undefined);
      storageService.headObject.mockResolvedValue({
        contentLength: 6291456,
        contentType: 'video/mp4',
      });
      processingQueue.enqueueProcess.mockResolvedValue(undefined);
    });

    it('should move the video to processing and enqueue only after the commit', async () => {
      const result = await service.completeUpload('user-1', 'video-1', parts);

      expect(result).toEqual({
        id: 'video-1',
        publicId: 'aZ3kQ9xLm2P',
        status: VideoStatus.PROCESSING,
      });
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1', status: VideoStatus.UPLOADING },
        {
          status: VideoStatus.PROCESSING,
          size_bytes: '6291456',
          upload_id: null,
        },
      );
      expect(processingQueue.enqueueProcess).toHaveBeenCalledWith('video-1');
      expect(videoRepository.update.mock.invocationCallOrder[0]).toBeLessThan(
        processingQueue.enqueueProcess.mock.invocationCallOrder[0],
      );
    });

    it('should report a video of another channel as not found', async () => {
      videoRepository.findOneBy.mockResolvedValueOnce(null);

      await expect(
        service.completeUpload('user-1', 'video-1', parts),
      ).rejects.toThrow(VideoNotFoundException);
      expect(videoRepository.findOneBy).toHaveBeenCalledWith({
        id: 'video-1',
        channel_id: 'channel-1',
      });
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject a video that is no longer uploading without touching storage', async () => {
      videoRepository.findOneBy.mockResolvedValueOnce({
        ...uploadingVideo,
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });

      await expect(
        service.completeUpload('user-1', 'video-1', parts),
      ).rejects.toThrow(InvalidVideoStateException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it.each([
      'InvalidPart',
      'InvalidPartOrder',
      'NoSuchUpload',
      'EntityTooSmall',
    ])(
      'should map a storage %s rejection to UPLOAD_COMPLETION_FAILED and keep the video uploading',
      async (name) => {
        storageService.completeMultipartUpload.mockRejectedValueOnce(
          storageRejection(name),
        );

        await expect(
          service.completeUpload('user-1', 'video-1', parts),
        ).rejects.toThrow(UploadCompletionFailedException);
        expect(videoRepository.update).not.toHaveBeenCalled();
        expect(processingQueue.enqueueProcess).not.toHaveBeenCalled();
      },
    );

    it('should propagate storage failures that are not part rejections', async () => {
      storageService.completeMultipartUpload.mockRejectedValueOnce(
        new Error('storage unavailable'),
      );

      await expect(
        service.completeUpload('user-1', 'video-1', parts),
      ).rejects.toThrow('storage unavailable');
    });

    it('should delete the object and mark the video as error on a size mismatch', async () => {
      storageService.headObject.mockResolvedValueOnce({
        contentLength: 6291455,
        contentType: 'video/mp4',
      });

      await expect(
        service.completeUpload('user-1', 'video-1', parts),
      ).rejects.toThrow(UploadSizeMismatchException);
      expect(storageService.deleteObject).toHaveBeenCalledWith(
        'videos',
        'video-1/source',
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        {
          status: VideoStatus.ERROR,
          processing_error: 'UPLOAD_SIZE_MISMATCH',
          upload_id: null,
        },
      );
      expect(processingQueue.enqueueProcess).not.toHaveBeenCalled();
    });

    it('should not enqueue when a concurrent completion already moved the video', async () => {
      videoRepository.update.mockResolvedValueOnce({ affected: 0 });

      await expect(
        service.completeUpload('user-1', 'video-1', parts),
      ).rejects.toThrow(InvalidVideoStateException);
      expect(processingQueue.enqueueProcess).not.toHaveBeenCalled();
    });

    it('should still succeed when enqueuing fails after the commit (reconciliation recovers it)', async () => {
      processingQueue.enqueueProcess.mockRejectedValueOnce(
        new Error('redis down'),
      );

      await expect(
        service.completeUpload('user-1', 'video-1', parts),
      ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });
    });
  });
  describe('getVideo / getPlaybackUrl', () => {
    const readyVideo = {
      id: 'video-1',
      public_id: 'aZ3kQ9xLm2P',
      channel_id: 'channel-1',
      title: 'Ready',
      status: VideoStatus.READY,
      publication_status: VideoPublicationStatus.DRAFT,
      processing_error: null,
      duration_seconds: 2,
      width: 320,
      height: 240,
      size_bytes: '17089',
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      thumbnail_key: 'video-1/default.jpg',
      source_key: 'video-1/source',
      original_filename: 'sample.mp4',
      created_at: new Date('2026-10-16T10:00:00Z'),
      processed_at: new Date('2026-10-16T10:01:00Z'),
    };

    beforeEach(() => {
      videoRepository.findOneBy.mockResolvedValue({ ...readyVideo });
      storageService.presignGet.mockImplementation(
        (bucket: string, key: string) =>
          Promise.resolve(`https://storage/${bucket}/${key}`),
      );
    });

    it('should look the video up by public id inside the caller channel', async () => {
      const result = await service.getVideo('user-1', 'aZ3kQ9xLm2P');

      expect(videoRepository.findOneBy).toHaveBeenCalledWith({
        public_id: 'aZ3kQ9xLm2P',
        channel_id: 'channel-1',
      });
      expect(result).toMatchObject({
        publicId: 'aZ3kQ9xLm2P',
        status: 'ready',
        sizeBytes: 17089,
        thumbnailUrl: 'https://storage/thumbnails/video-1/default.jpg',
        createdAt: '2026-10-16T10:00:00.000Z',
        processedAt: '2026-10-16T10:01:00.000Z',
      });
    });

    it('should return a null thumbnailUrl while the video has no thumbnail', async () => {
      videoRepository.findOneBy.mockResolvedValueOnce({
        ...readyVideo,
        status: VideoStatus.PROCESSING,
        thumbnail_key: null,
        processed_at: null,
      });

      const result = await service.getVideo('user-1', 'aZ3kQ9xLm2P');

      expect(result.thumbnailUrl).toBeNull();
      expect(result.processedAt).toBeNull();
      expect(storageService.presignGet).not.toHaveBeenCalled();
    });

    it('should report another channel video as not found', async () => {
      videoRepository.findOneBy.mockResolvedValueOnce(null);

      await expect(
        service.getPlaybackUrl('user-1', 'aZ3kQ9xLm2P', 'stream'),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it.each([VideoStatus.UPLOADING, VideoStatus.PROCESSING, VideoStatus.ERROR])(
      'should refuse playback while the video is %s',
      async (status) => {
        videoRepository.findOneBy.mockResolvedValueOnce({
          ...readyVideo,
          status,
        });

        await expect(
          service.getPlaybackUrl('user-1', 'aZ3kQ9xLm2P', 'stream'),
        ).rejects.toThrow(VideoNotReadyException);
      },
    );

    it('should presign the source without Content-Disposition for streaming', async () => {
      const result = await service.getPlaybackUrl(
        'user-1',
        'aZ3kQ9xLm2P',
        'stream',
      );

      expect(storageService.presignGet).toHaveBeenCalledWith(
        'videos',
        'video-1/source',
        600,
        {},
      );
      expect(result.url).toBe('https://storage/videos/video-1/source');
      expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('should sign an attachment Content-Disposition with the original filename for download', async () => {
      await service.getPlaybackUrl('user-1', 'aZ3kQ9xLm2P', 'download');

      expect(storageService.presignGet).toHaveBeenCalledWith(
        'videos',
        'video-1/source',
        600,
        { contentDisposition: 'attachment; filename="sample.mp4"' },
      );
    });

    it('should neutralize quotes and line breaks in the filename', async () => {
      videoRepository.findOneBy.mockResolvedValueOnce({
        ...readyVideo,
        original_filename: 'evil"\r\nX-Injected: 1.mp4',
      });

      await service.getPlaybackUrl('user-1', 'aZ3kQ9xLm2P', 'download');

      expect(storageService.presignGet).toHaveBeenCalledWith(
        'videos',
        'video-1/source',
        600,
        {
          contentDisposition: 'attachment; filename="evil___X-Injected: 1.mp4"',
        },
      );
    });
  });
});
