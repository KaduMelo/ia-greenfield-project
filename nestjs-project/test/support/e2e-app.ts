import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../../src/app.module';
import { MailService } from '../../src/mail/mail.service';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { useTestStorageBuckets } from '../../src/test/storage';

export const E2E_QUEUE_PREFIX = 'streamtube-e2e';

export interface E2eApp {
  app: INestApplication<App>;
  moduleFixture: TestingModule;
  throttlerStorage: ThrottlerStorageService;
}

/**
 * Boots AppModule with the global config `main.ts` applies, pointed at the
 * test buckets and a test queue prefix so jobs never reach the real worker.
 */
export async function createE2eApp(): Promise<E2eApp> {
  useTestStorageBuckets();
  process.env.QUEUE_PREFIX = E2E_QUEUE_PREFIX;

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  return {
    app,
    moduleFixture,
    throttlerStorage:
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage),
  };
}

/** Registers a user, confirms the email (token captured from the mailer) and logs in. */
export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<string> {
  // MailService is a singleton: spying on it intercepts AuthService's call.
  let confirmationToken = '';
  jest
    .spyOn(app.get(MailService), 'sendConfirmationEmail')
    .mockImplementationOnce((_e: string, _n: string, token: string) => {
      confirmationToken = token;
      return Promise.resolve();
    });

  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: confirmationToken })
    .expect(204);
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);

  return (login.body as { access_token: string }).access_token;
}

/** Typed view of a supertest response body (supertest types it as `any`). */
export function bodyOf<T>(res: { body: unknown }): T {
  return res.body as T;
}
