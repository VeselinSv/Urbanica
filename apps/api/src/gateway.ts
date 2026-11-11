import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Client as PgClient } from 'pg';
import type { Server, Socket } from 'socket.io';
import { PG_CHANNEL, canReceive, normalizeChannel, sessionUser, type BusEvent } from '@gce/domain';
import { metrics, prisma } from './common';

/**
 * WebSocket шлюз (socket.io). Събитията идват от PostgreSQL LISTEN/NOTIFY (worker и API процеси),
 * затова клиентите получават само потвърдени (commit-нати) промени. Стаи: user:<id>, chan:<channel>, world.
 */
@WebSocketGateway({ path: '/socket.io', cors: { origin: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(','), credentials: true } })
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private readonly log = new Logger('Gateway');
  private pg: PgClient | null = null;
  private stopped = false;

  async onModuleInit() {
    await this.listen();
  }

  async onModuleDestroy() {
    this.stopped = true;
    await this.pg?.end().catch(() => undefined);
  }

  private async listen() {
    if (this.stopped) return;
    try {
      const pg = new PgClient({ connectionString: process.env.DATABASE_URL });
      pg.on('error', (e) => {
        this.log.warn(`pg listener error: ${e.message}; reconnecting`);
        this.pg = null;
        setTimeout(() => void this.listen(), 2000);
      });
      await pg.connect();
      await pg.query(`LISTEN ${PG_CHANNEL}`);
      pg.on('notification', (n) => {
        if (!n.payload) return;
        try {
          this.route(JSON.parse(n.payload) as BusEvent);
        } catch {
          /* невалидно съобщение – игнорира се */
        }
      });
      this.pg = pg;
      this.log.log('listening for game events');
    } catch (e) {
      this.log.warn(`cannot LISTEN (${(e as Error).message}); retrying`);
      setTimeout(() => void this.listen(), 3000);
    }
  }

  private route(ev: BusEvent) {
    if (!this.server) return;
    switch (ev.type) {
      case 'tick':
        this.server.to('world').emit('tick', { tick: ev.tick });
        break;
      case 'notification':
        this.server.to(`user:${ev.userId}`).emit('notification', ev);
        break;
      case 'city':
        this.server.to(`user:${ev.ownerId}`).emit('city', { cityId: ev.cityId });
        this.server.to('world').emit('cityChanged', { cityId: ev.cityId });
        break;
      case 'market':
        this.server.to('world').emit('market', { instrument: ev.instrument });
        break;
      case 'chat':
        if (ev.channel === 'global') this.server.to('world').emit('chat', ev);
        else if (ev.channel.startsWith('dm:')) {
          for (const u of ev.channel.split(':').slice(1)) this.server.to(`user:${u}`).emit('chat', ev);
        } else this.server.to(`chan:${ev.channel}`).emit('chat', ev);
        break;
    }
  }

  async handleConnection(socket: Socket) {
    const token = (socket.handshake.auth as { token?: string })?.token;
    const user = await sessionUser(prisma, token).catch(() => null);
    socket.join('world');
    if (user) {
      socket.data.userId = user.id;
      socket.join(`user:${user.id}`);
    }
    metrics.wsConnections++;
  }

  handleDisconnect() {
    metrics.wsConnections = Math.max(0, metrics.wsConnections - 1);
  }

  /** Абониране за корпоративен/съюзен канал – с проверка на правата на сървъра. */
  @SubscribeMessage('join')
  async join(socket: Socket, channel: string) {
    const userId = socket.data.userId as string | undefined;
    if (!userId || typeof channel !== 'string') return { ok: false };
    const ch = normalizeChannel(userId, channel);
    if (!(await canReceive(prisma, userId, ch))) return { ok: false };
    socket.join(`chan:${ch}`);
    return { ok: true };
  }
}
