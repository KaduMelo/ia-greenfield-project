import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import type { Queue } from 'bullmq';
import queueConfig from '../../config/queue.config';
import { QueueModule } from '../../queue/queue.module';
import { openVideoProcessingQueue, useTestQueuePrefix } from '../../test/queue';
import { processJobId } from './video-processing.constants';
import { VideoProcessingQueue } from './video-processing.queue';

describe('VideoProcessingQueue (integration)', () => {
  let module: TestingModule;
  let producer: VideoProcessingQueue;
  let testQueue: Queue;
  let productionQueue: Queue;

  beforeAll(async () => {
    useTestQueuePrefix();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
      providers: [VideoProcessingQueue],
    }).compile();
    producer = module.get(VideoProcessingQueue);
    testQueue = openVideoProcessingQueue();
    productionQueue = openVideoProcessingQueue('streamtube');
  });

  beforeEach(async () => {
    await testQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    await testQueue.obliterate({ force: true });
    await testQueue.close();
    await productionQueue.close();
    await module.close();
  });

  it('should add a process job with a deterministic id, the video id and the retry policy', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcess(videoId);

    const job = await testQueue.getJob(processJobId(videoId));
    expect(job).toBeDefined();
    expect(job!.name).toBe('process');
    expect(job!.data).toEqual({ videoId });
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });

  it('should not duplicate the job when enqueued twice while it is still in the queue', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcess(videoId);
    await producer.enqueueProcess(videoId);

    const counts = await testQueue.getJobCounts('waiting', 'delayed', 'active');
    expect(counts.waiting + counts.delayed + counts.active).toBe(1);
  });

  it('should keep jobs under the test prefix out of the production prefix', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcess(videoId);

    expect(await productionQueue.getJob(processJobId(videoId))).toBeUndefined();
  });
});
