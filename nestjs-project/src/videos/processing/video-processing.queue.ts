import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PROCESS_JOB_OPTIONS,
  type ProcessVideoJobData,
  VIDEO_PROCESSING_JOBS,
  VIDEO_PROCESSING_QUEUE,
  processJobId,
} from './video-processing.constants';

/** Single producer of `process` jobs (video-processing-job-delivery/TD-01). */
@Injectable()
export class VideoProcessingQueue {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  async enqueueProcess(videoId: string): Promise<void> {
    await this.queue.add(
      VIDEO_PROCESSING_JOBS.PROCESS,
      { videoId },
      { ...PROCESS_JOB_OPTIONS, jobId: processJobId(videoId) },
    );
  }
}
