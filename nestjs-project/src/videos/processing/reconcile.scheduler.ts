import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import queueConfig from '../../config/queue.config';
import {
  RECONCILE_SCHEDULER_ID,
  VIDEO_PROCESSING_JOBS,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';

/**
 * Registers the periodic `reconcile` job on worker boot. `upsertJobScheduler`
 * is idempotent, so every worker start just refreshes the same scheduler
 * (video-processing-job-delivery/TD-01).
 */
@Injectable()
export class ReconcileScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      RECONCILE_SCHEDULER_ID,
      { every: this.config.reconcileIntervalMs },
      { name: VIDEO_PROCESSING_JOBS.RECONCILE },
    );
  }
}
