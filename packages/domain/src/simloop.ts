import { hostname } from 'node:os';
import type { PrismaClient } from '@gce/database';
import { acquireLease, processTick, releaseLease } from './simulation';
import { worldRow } from './world';

type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void;

/**
 * Цикъл на симулацията: единствен лидер (лиз в базата) изпълнява игровите тикове по централния часовник.
 * Използва се от отделния worker и – при безплатно хостване – вътре в API процеса (EMBEDDED_WORKER=true).
 * След рестарт/заспиване пропуснатите тикове се наваксват (ограничено), като всяка фаза е идемпотентна.
 */
export function runSimulationLoop(prisma: PrismaClient, log: Log): { stop: () => Promise<void> } {
  const holder = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  let stopping = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const loop = async () => {
    log('info', 'simulation loop started', { holder });
    let leader = false;
    let failures = 0;
    while (!stopping) {
      try {
        const got = await acquireLease(prisma, holder);
        if (got !== leader) log('info', got ? 'acquired leadership' : 'lost leadership');
        leader = got;
        if (!leader) {
          await sleep(5000);
          continue;
        }
        const w = await worldRow(prisma);
        const wait = w.lastTickAt.getTime() + w.tickIntervalMs - Date.now();
        if (wait > 0) {
          await sleep(Math.min(wait, 2000));
          continue;
        }
        const r = await processTick(prisma);
        failures = 0;
        log('info', 'tick', { tick: r.tick, ms: r.durationMs, phases: r.phases, counts: r.counts });
        if (r.durationMs > w.tickIntervalMs * 0.8) log('warn', 'tick is close to interval – consider scaling', { ms: r.durationMs });
      } catch (e) {
        failures++;
        log('error', 'tick failed', { error: (e as Error).message, stack: (e as Error).stack, failures });
        await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
      }
    }
  };
  void loop();
  return {
    stop: async () => {
      stopping = true;
      await releaseLease(prisma, holder).catch(() => undefined);
    },
  };
}
