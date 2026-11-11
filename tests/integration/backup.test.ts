import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { processTick } from '@gce/domain';
import { cityWithRoad, expectInvariants, player, prisma, resetDb } from './helpers';
// @ts-expect-error – JS модул без типове
import { backup, restore } from '../../scripts/backup-lib.mjs';

beforeAll(async () => {
  await resetDb();
});

describe('Резервно копие и възстановяване', () => {
  it('създава копие, данните се променят, възстановяването връща точното състояние', async () => {
    const p = await player('Bak');
    await cityWithRoad(p.id);
    await processTick(prisma);
    const file = join(mkdtempSync(join(tmpdir(), 'gce-bak-')), 'b.json.gz');
    const snapshot = {
      users: await prisma.user.count(),
      ledger: await prisma.ledgerEntry.count(),
      tick: (await prisma.world.findUniqueOrThrow({ where: { id: 1 } })).tick,
    };
    const r = await backup(process.env.DATABASE_URL, file);
    expect(r.rows).toBeGreaterThan(10);
    // Промени след копието
    await player('After');
    await processTick(prisma);
    expect(await prisma.user.count()).toBe(snapshot.users + 1);
    await restore(process.env.DATABASE_URL, file);
    expect(await prisma.user.count()).toBe(snapshot.users);
    expect(await prisma.ledgerEntry.count()).toBe(snapshot.ledger);
    expect((await prisma.world.findUniqueOrThrow({ where: { id: 1 } })).tick).toBe(snapshot.tick);
    await expectInvariants();
    // Броячите са синхронизирани – новите записи не се сблъскват.
    await processTick(prisma);
    await player('PostRestore');
    await expectInvariants();
  });
});
