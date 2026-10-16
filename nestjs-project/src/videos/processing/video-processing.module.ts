import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaModule } from '../../media/media.module';
import { QueueModule } from '../../queue/queue.module';
import { StorageModule } from '../../storage/storage.module';
import { Video } from '../entities/video.entity';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { VideoProcessingQueue } from './video-processing.queue';
import { VideoProcessingService } from './video-processing.service';

/**
 * Worker-side processing. Not imported by AppModule: the API only produces
 * jobs; consuming happens in the video-worker container (phase-03-videos/TD-07).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    MediaModule,
    QueueModule,
  ],
  providers: [
    VideoProcessingService,
    VideoProcessingConsumer,
    VideoProcessingQueue,
  ],
})
export class VideoProcessingModule {}
