import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { useTestQueuePrefix } from '../test/queue';
import { VIDEO_PROCESSING_QUEUE } from '../videos/processing/video-processing.constants';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  it('should compile and register the video-processing queue with the configured prefix', async () => {
    useTestQueuePrefix();
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue).toBeInstanceOf(Queue);
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
    expect(queue.opts.prefix).toBe('streamtube-test');
    await module.close();
  });
});
