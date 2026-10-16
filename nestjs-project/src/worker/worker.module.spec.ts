import { Test } from '@nestjs/testing';
import { ModulesContainer } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { useTestQueuePrefix } from '../test/queue';
import {
  RECONCILE_SCHEDULER_ID,
  VIDEO_PROCESSING_QUEUE,
} from '../videos/processing/video-processing.constants';
import { VideoProcessingConsumer } from '../videos/processing/video-processing.consumer';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should boot the real worker graph (config, TypeORM autoLoadEntities, queue) with no HTTP controller', async () => {
    useTestQueuePrefix();
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    // Runs onApplicationBootstrap hooks (ReconcileScheduler) like the real entrypoint.
    await module.init();

    expect(module.get(VideoProcessingConsumer)).toBeInstanceOf(
      VideoProcessingConsumer,
    );

    const controllers = [...module.get(ModulesContainer).values()].flatMap(
      (m) => [...m.controllers.keys()],
    );
    expect(controllers).toHaveLength(0);

    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toContain(RECONCILE_SCHEDULER_ID);

    await queue.removeJobScheduler(RECONCILE_SCHEDULER_ID);
    await module.close();
  }, 30000);
});
