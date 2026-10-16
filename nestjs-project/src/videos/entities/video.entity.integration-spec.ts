import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id.util';
import {
  MAX_VIDEO_SIZE_BYTES,
  Video,
  VideoPublicationStatus,
  VideoStatus,
} from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;
  let counter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    userRepository = dataSource.getRepository(User);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    // Deleting channels cascades to their videos (FK ON DELETE CASCADE).
    await cleanAllTables(dataSource);
  });

  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_owner_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `video_owner_${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, overrides: Partial<Video> = {}) {
    return videoRepository.create({
      channel_id: channelId,
      public_id: generatePublicId(),
      title: 'My video',
      original_filename: 'my-video.mp4',
      content_type: 'video/mp4',
      declared_size_bytes: '1048576',
      source_key: 'pending/source',
      ...overrides,
    });
  }

  it('should default status to uploading and publication_status to draft', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel.id));
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.UPLOADING);
    expect(found.publication_status).toBe(VideoPublicationStatus.DRAFT);
    expect(found.processing_error).toBeNull();
    expect(found.thumbnail_key).toBeNull();
  });

  it('should reject two videos with the same public_id', async () => {
    const channel = await createChannel();
    const publicId = generatePublicId();
    await videoRepository.save(buildVideo(channel.id, { public_id: publicId }));

    await expect(
      videoRepository.save(buildVideo(channel.id, { public_id: publicId })),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should reject declared_size_bytes above 10GB', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        buildVideo(channel.id, {
          declared_size_bytes: String(MAX_VIDEO_SIZE_BYTES + 1),
        }),
      ),
    ).rejects.toThrow(/CHK_videos_declared_size_bytes/);
  });

  it('should accept declared_size_bytes of exactly 10GB', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      buildVideo(channel.id, {
        declared_size_bytes: String(MAX_VIDEO_SIZE_BYTES),
      }),
    );

    expect(saved.id).toBeDefined();
  });

  it('should delete the videos of a channel when the channel is deleted', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel.id));

    await channelRepository.delete({ id: channel.id });

    expect(await videoRepository.findOneBy({ id: saved.id })).toBeNull();
  });

  it('should read duration_seconds back as a number', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      buildVideo(channel.id, { duration_seconds: 2.04 }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.duration_seconds).toBe(2.04);
  });
});
