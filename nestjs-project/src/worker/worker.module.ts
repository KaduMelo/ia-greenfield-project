import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { CONFIG_MODULE_OPTIONS } from '../config/config-module.options';
import databaseConfig from '../config/database.config';
import { buildTypeOrmOptions } from '../database/typeorm-options.factory';
import { QueueModule } from '../queue/queue.module';
import { User } from '../users/entities/user.entity';
import { ReconcileScheduler } from '../videos/processing/reconcile.scheduler';
import { VideoProcessingModule } from '../videos/processing/video-processing.module';

/**
 * Root module of the video-worker container: no HTTP, no auth — only the
 * queue consumer and the reconciliation scheduler (phase-03-videos/TD-07).
 */
@Module({
  imports: [
    ConfigModule.forRoot(CONFIG_MODULE_OPTIONS),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: buildTypeOrmOptions,
    }),
    // autoLoadEntities only sees forFeature() entities; Video → Channel ↔ User
    // must all be registered for TypeORM to build Video's relation metadata.
    TypeOrmModule.forFeature([Channel, User]),
    QueueModule,
    VideoProcessingModule,
  ],
  providers: [ReconcileScheduler],
})
export class WorkerModule {}
