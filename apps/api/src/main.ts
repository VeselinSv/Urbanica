import 'reflect-metadata';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { loadEnv } from './env';

loadEnv();

// BigInt (суми в центове) се сериализира като число; стойностите са проверени за безопасен диапазон.
(BigInt.prototype as unknown as { toJSON: () => number | string }).toJSON = function (this: bigint) {
  const n = Number(this);
  return Number.isSafeInteger(n) ? n : this.toString();
};

async function bootstrap() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { AppModule } = await import('./app.module');
  const { metrics, prisma } = await import('./common');
  const { ensureWorld } = await import('@gce/domain');
  await ensureWorld(prisma, process.env.WORLD_SEED ?? 'gce-alpha-1', Number(process.env.GAME_DAY_MS ?? 1000));

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['log', 'warn', 'error'] });
  app.set('trust proxy', 1);
  app.useBodyParser('json', { limit: '256kb' });
  // CORS: изрично зададени адреси, иначе публичният адрес от Render (RENDER_EXTERNAL_URL), иначе локалният Vite.
  const origins = (process.env.CORS_ORIGINS ?? process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:5173').split(',');
  app.enableCors({ origin: origins, credentials: true });
  app.enableShutdownHooks();

  // Заглавки за сигурност и метрики за всяка заявка.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      if (!req.path.startsWith('/api')) return;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      metrics.requests++;
      metrics.totalMs += ms;
      if (res.statusCode >= 500) metrics.errors++;
      if (ms > 500) metrics.slow++;
      const route = `${req.method} ${(req.route?.path as string | undefined) ?? req.path.replace(/[a-z0-9]{20,}/g, ':id')}`;
      const r = metrics.byRoute.get(route) ?? { n: 0, ms: 0 };
      r.n++;
      r.ms += ms;
      metrics.byRoute.set(route, r);
    });
    next();
  });
  app.setGlobalPrefix('api');

  // В production API сървърът обслужва и билднатия клиент (един услуга = по-просто разполагане).
  const webDist = resolve(process.env.WEB_DIST ?? join(__dirname, '../../web/dist'));
  if (existsSync(join(webDist, 'index.html'))) {
    app.useStaticAssets(webDist, { index: false, maxAge: '1h' });
    const indexHtml = readFileSync(join(webDist, 'index.html'), 'utf8');
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(indexHtml);
    });
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  // Безплатно хостване: симулацията върви в същия процес (без отделен worker).
  if (process.env.EMBEDDED_WORKER === 'true') {
    const { runSimulationLoop } = await import('@gce/domain');
    const sim = runSimulationLoop(prisma, (level, msg, extra = {}) =>
      console.log(JSON.stringify({ t: new Date().toISOString(), level, svc: 'api-sim', msg, ...extra })),
    );
    process.once('SIGTERM', () => void sim.stop());
  }
  console.log(
    JSON.stringify({ t: new Date().toISOString(), level: 'info', svc: 'api', msg: `API listening on :${port}`, web: existsSync(join(webDist, 'index.html')) }),
  );
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
