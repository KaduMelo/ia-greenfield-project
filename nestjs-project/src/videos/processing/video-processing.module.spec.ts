import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import { createTestDataSource } from '../../test/create-test-data-source';
import { useTestQueuePrefix } from '../../test/queue';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingQueue } from './video-processing.queue';
import { VideoProcessingService } from './video-processing.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingModule', () => {
  it('should compile the worker-side providers without any HTTP controller', async () => {
    useTestQueuePrefix();
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideoProcessingModule,
      ],
    }).compile();

    expect(module.get(VideoProcessingService)).toBeInstanceOf(
      VideoProcessingService,
    );
    expect(module.get(VideoProcessingConsumer)).toBeInstanceOf(
      VideoProcessingConsumer,
    );
    expect(module.get(VideoProcessingQueue)).toBeInstanceOf(
      VideoProcessingQueue,
    );
    expect(
      Reflect.getMetadata('controllers', VideoProcessingModule) ?? [],
    ).toHaveLength(0);
    await module.close();
  }, 30000);
});
