import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { User } from '@gce/database';
import {
  AllianceSchema,
  ChatSchema,
  FriendSchema,
  InviteSchema,
  LicenseFeeSchema,
  LicenseRequestSchema,
  ProposalSchema,
  ReportSchema,
  VoteSchema,
} from '@gce/shared';
import * as D from '@gce/domain';
import { z } from 'zod';
import { CurrentUser, Public, metrics, parse, prisma } from './common';

// ---------------------------------------------------------------- Корпоративно управление
@Controller('proposals')
export class GovernanceController {
  @Get()
  list(@Query('scopeType') scopeType: string, @Query('scopeId') scopeId: string) {
    return D.listProposals(prisma, scopeType, scopeId);
  }

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: User) {
    return D.createProposal(prisma, user.id, parse(ProposalSchema, body));
  }

  @Post(':id/vote')
  vote(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: User) {
    return D.castVote(prisma, user.id, id, parse(VoteSchema, body).approve);
  }
}

// ---------------------------------------------------------------- Технологии
@Controller('tech')
export class TechController {
  @Public()
  @Get()
  list() {
    return D.techOverview(prisma);
  }

  @Post('patents/:id/fee')
  fee(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: User) {
    return D.setLicenseFee(prisma, user.id, id, parse(LicenseFeeSchema, body).dailyFee);
  }

  @Post('patents/:id/license')
  license(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: User) {
    return D.requestLicense(prisma, user.id, id, parse(LicenseRequestSchema, body).companyId);
  }

  @Delete('patents/:id/license/:companyId')
  cancel(@Param('id') id: string, @Param('companyId') companyId: string, @CurrentUser() user: User) {
    return D.cancelLicense(prisma, user.id, id, companyId);
  }
}

// ---------------------------------------------------------------- Дипломация
@Controller('alliances')
export class AllianceController {
  @Get()
  list(@CurrentUser() user: User) {
    return D.alliances(prisma, user.id);
  }

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: User) {
    return D.createAlliance(prisma, user.id, parse(AllianceSchema, body));
  }

  @Post(':id/invite')
  invite(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: User) {
    return D.inviteToAlliance(prisma, user.id, id, parse(InviteSchema, body).username);
  }

  @Post('invites/:id/:answer')
  respond(@Param('id') id: string, @Param('answer') answer: string, @CurrentUser() user: User) {
    return D.respondInvite(prisma, user.id, id, answer === 'accept');
  }

  @Post('leave')
  leave(@CurrentUser() user: User) {
    return D.leaveAlliance(prisma, user.id);
  }
}

// ---------------------------------------------------------------- Социални функции
@Controller('social')
export class SocialController {
  @Get('chat')
  history(@Query('channel') channel: string, @Query('before') before: string | undefined, @CurrentUser() user: User) {
    return D.chatHistory(prisma, user.id, channel || 'global', before && /^\d+$/.test(before) ? before : undefined);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('chat')
  send(@Body() body: unknown, @CurrentUser() user: User) {
    const b = parse(ChatSchema, body);
    return D.sendChat(prisma, user.id, b.channel, b.body);
  }

  @Get('friends')
  friends(@CurrentUser() user: User) {
    return D.friends(prisma, user.id);
  }

  @Post('friends')
  addFriend(@Body() body: unknown, @CurrentUser() user: User) {
    return D.friendRequest(prisma, user.id, parse(FriendSchema, body).username);
  }

  @Post('block/:userId')
  block(@Param('userId') userId: string, @Body() body: unknown, @CurrentUser() user: User) {
    const b = parse(z.object({ on: z.boolean().default(true) }), body ?? {});
    return D.block(prisma, user.id, userId, b.on);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('report')
  report(@Body() body: unknown, @CurrentUser() user: User) {
    return D.report(prisma, user.id, parse(ReportSchema, body));
  }

  @Post('moderate/:userId')
  moderate(@Param('userId') userId: string, @Body() body: unknown, @CurrentUser() user: User) {
    const b = parse(
      z.object({
        minutes: z
          .number()
          .int()
          .min(1)
          .max(60 * 24 * 30),
      }),
      body,
    );
    return D.moderate(prisma, user.id, userId, b.minutes);
  }

  @Get('notifications')
  notifications(@CurrentUser() user: User) {
    return D.notifications(prisma, user.id);
  }

  @Post('notifications/read')
  read(@CurrentUser() user: User) {
    return D.markNotificationsRead(prisma, user.id);
  }

  @Get('users')
  async users(@Query('q') q: string) {
    const list = await prisma.user.findMany({
      where: q ? { username: { contains: q, mode: 'insensitive' } } : undefined,
      select: { id: true, username: true },
      take: 20,
    });
    return list;
  }
}

// ---------------------------------------------------------------- Здраве и метрики
@Controller()
export class HealthController {
  @Public()
  @Get('health')
  async health() {
    const t0 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const w = await prisma.world.findUnique({ where: { id: 1 } });
    const lag = w ? Date.now() - w.lastTickAt.getTime() - w.tickIntervalMs : null;
    return { status: 'ok', db: 'ok', dbLatencyMs: Date.now() - t0, tick: w?.tick ?? null, simulationLagMs: lag, uptimeS: Math.round(process.uptime()) };
  }

  @Public()
  @Get('metrics')
  async metricsRoute() {
    const runs = await prisma.tickRun.findMany({ orderBy: { tick: 'desc' }, take: 10 });
    return {
      requests: metrics.requests,
      errors: metrics.errors,
      avgResponseMs: metrics.requests ? Math.round((metrics.totalMs / metrics.requests) * 10) / 10 : 0,
      slowRequests: metrics.slow,
      wsConnections: metrics.wsConnections,
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      routes: [...metrics.byRoute.entries()]
        .map(([k, v]) => ({ route: k, n: v.n, avgMs: Math.round(v.ms / v.n) }))
        .sort((a, b) => b.n - a.n)
        .slice(0, 25),
      simulation: runs.map((r) => ({ tick: r.tick, durationMs: r.durationMs, phases: r.phases })),
    };
  }
}
