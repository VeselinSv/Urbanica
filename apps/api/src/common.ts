import {
  ArgumentsHost,
  BadRequestException,
  CanActivate,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ZodError, type z } from 'zod';
import { DomainError, sessionUser } from '@gce/domain';
import { getPrisma, type User } from '@gce/database';
import { zodMessage } from '@gce/shared';

export const prisma = getPrisma();

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export interface AuthedRequest extends Request {
  user?: User;
  token?: string;
}

export function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  return undefined;
}

/** Глобален guard: всички маршрути изискват валидна сесия, освен маркираните с @Public. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = bearer(req);
    const user = token ? await sessionUser(prisma, token) : null;
    if (user) {
      req.user = user;
      req.token = token;
    }
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    if (!user) throw new HttpException({ statusCode: 401, code: 'UNAUTHORIZED', message: 'Необходим е вход' }, 401);
    return true;
  }
}

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().user as User);
export const IdemKey = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  const v = ctx.switchToHttp().getRequest<Request>().headers['idempotency-key'];
  return typeof v === 'string' && v.length <= 120 ? v : undefined;
});

/** Валидиране на входните данни на границата на системата (zod). */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new BadRequestException({ statusCode: 400, code: 'VALIDATION', message: zodMessage(r.error) });
  return r.data;
}

/** Централизирана обработка на грешки – единен формат {statusCode, code, message}. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    if (e instanceof DomainError) return res.status(e.status).json({ statusCode: e.status, code: e.code, message: e.message });
    if (e instanceof ZodError) return res.status(400).json({ statusCode: 400, code: 'VALIDATION', message: zodMessage(e) });
    if (e instanceof ThrottlerException)
      return res.status(429).json({ statusCode: 429, code: 'RATE_LIMIT', message: 'Твърде много заявки – опитайте по-късно' });
    if (e instanceof HttpException) {
      const body = e.getResponse();
      const status = e.getStatus();
      if (typeof body === 'object' && body && 'code' in body) return res.status(status).json(body);
      return res.status(status).json({
        statusCode: status,
        code: status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR',
        message: typeof body === 'string' ? body : ((body as { message?: string }).message ?? e.message),
      });
    }
    const code = (e as { code?: string }).code;
    if (code === 'P2002') return res.status(409).json({ statusCode: 409, code: 'CONFLICT', message: 'Конфликт – ресурсът вече съществува' });
    if (code === 'P2025') return res.status(404).json({ statusCode: 404, code: 'NOT_FOUND', message: 'Не е намерено' });
    this.log.error(JSON.stringify({ msg: 'unhandled error', path: req.url, method: req.method, error: (e as Error).message, stack: (e as Error).stack }));
    return res.status(500).json({ statusCode: 500, code: 'INTERNAL', message: 'Вътрешна грешка на сървъра' });
  }
}

/** Прости метрики в паметта на процеса (време за отговор, брой заявки, грешки). */
export const metrics = {
  started: Date.now(),
  requests: 0,
  errors: 0,
  totalMs: 0,
  slow: 0,
  wsConnections: 0,
  byRoute: new Map<string, { n: number; ms: number }>(),
};
