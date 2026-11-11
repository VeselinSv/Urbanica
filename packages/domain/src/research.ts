import { BALANCE, SERVICES, TECHS, TECH_IDS, type TechId, type TileMap } from '@gce/shared';
import { withTx, type PrismaClient, type Tx } from '@gce/database';
import { bad, conflict, forbidden, notFound } from './errors';
import { SYS, acc, tryTransfer, transfer } from './ledger';
import { currentTick } from './world';
import { requirePermission } from './companies';
import { logEvent, notify } from './events';

/** Технологиите, достъпни за компания: собствени патенти, активни лицензи и обществено достояние. */
export async function companyTechs(db: Tx | PrismaClient, companyId: string, tick: number): Promise<TechId[]> {
  const patents = await db.patent.findMany();
  const licenses = await db.license.findMany({ where: { companyId, status: 'ACTIVE' } });
  const licensed = new Set(licenses.map((l) => l.patentId));
  const out: TechId[] = [];
  for (const p of patents) {
    const isPublic = p.public || p.expiresTick <= tick;
    if (isPublic || p.ownerCompanyId === companyId || licensed.has(p.id)) out.push(p.techId as TechId);
  }
  return out;
}

export async function techOverview(prisma: PrismaClient) {
  const tick = await currentTick(prisma);
  const patents = await prisma.patent.findMany();
  const owners = await prisma.company.findMany({
    where: { id: { in: patents.map((p) => p.ownerCompanyId).filter(Boolean) as string[] } },
    select: { id: true, name: true },
  });
  const oname = new Map(owners.map((o) => [o.id, o.name]));
  const active = await prisma.researchProject.findMany({ where: { status: 'ACTIVE' } });
  return TECH_IDS.map((id) => {
    const p = patents.find((x) => x.techId === id);
    return {
      ...TECHS[id],
      patent: p
        ? {
            id: p.id,
            owner: p.ownerCompanyId ? (oname.get(p.ownerCompanyId) ?? null) : null,
            ownerCompanyId: p.ownerCompanyId,
            public: p.public || p.expiresTick <= tick,
            licenseFee: Number(p.licenseFee),
            expiresTick: p.expiresTick,
          }
        : null,
      researchers: active.filter((r) => r.techId === id).length,
    };
  });
}

/** Компания започва изследване. Патентованите технологии не могат да се изследват повторно – лицензират се. */
export async function startResearch(prisma: PrismaClient, userId: string, companyId: string, techId: TechId) {
  return withTx(prisma, async (tx) => {
    await requirePermission(tx, companyId, userId, 'research');
    const tick = await currentTick(tx);
    if (await tx.patent.findUnique({ where: { techId } })) throw conflict('Технологията вече е патентована – можете да я лицензирате');
    const existing = await tx.researchProject.findFirst({ where: { companyId, techId, status: 'ACTIVE' } });
    if (existing) throw conflict('Вече изследвате тази технология');
    const t = TECHS[techId];
    return tx.researchProject.create({ data: { companyId, techId, requiredDays: t.days, dailyCost: BigInt(t.dailyCost), startedTick: tick } });
  });
}

/** Публично финансирано изследване от град: по-скъпо, но резултатът е обществено достояние (без монопол). */
export async function startPublicResearch(prisma: PrismaClient, userId: string, cityId: string, techId: TechId) {
  return withTx(prisma, async (tx) => {
    const city = await tx.city.findUnique({ where: { id: cityId } });
    if (!city) throw notFound('Градът');
    if (city.ownerId !== userId) throw forbidden();
    const hasUni = Object.values(city.tiles as unknown as TileMap).some((t) => t.t === 'service' && t.s === 'university');
    if (!hasUni) throw bad(`Нужен е ${SERVICES.university.name.toLowerCase()} в града`);
    if (await tx.patent.findUnique({ where: { techId } })) throw conflict('Технологията вече съществува');
    const tick = await currentTick(tx);
    const t = TECHS[techId];
    return tx.researchProject.create({
      data: { cityId, techId, requiredDays: t.days, dailyCost: BigInt(Math.round(t.dailyCost * BALANCE.research.publicResearchCostMult)), startedTick: tick },
    });
  });
}

export async function setLicenseFee(prisma: PrismaClient, userId: string, patentId: string, dailyFee: number) {
  return withTx(prisma, async (tx) => {
    const p = await tx.patent.findUnique({ where: { id: patentId } });
    if (!p || !p.ownerCompanyId) throw notFound('Патентът');
    await requirePermission(tx, p.ownerCompanyId, userId, 'license');
    return tx.patent.update({ where: { id: patentId }, data: { licenseFee: BigInt(dailyFee) } });
  });
}

export async function requestLicense(prisma: PrismaClient, userId: string, patentId: string, companyId: string) {
  return withTx(prisma, async (tx) => {
    await requirePermission(tx, companyId, userId, 'license');
    const p = await tx.patent.findUnique({ where: { id: patentId } });
    if (!p || !p.ownerCompanyId) throw notFound('Патентът');
    if (p.ownerCompanyId === companyId) throw bad('Компанията притежава патента');
    const tick = await currentTick(tx);
    return tx.license.upsert({
      where: { patentId_companyId: { patentId, companyId } },
      create: { patentId, companyId, startedTick: tick },
      update: { status: 'ACTIVE', startedTick: tick },
    });
  });
}

export async function cancelLicense(prisma: PrismaClient, userId: string, patentId: string, companyId: string) {
  return withTx(prisma, async (tx) => {
    await requirePermission(tx, companyId, userId, 'license');
    return tx.license.update({ where: { patentId_companyId: { patentId, companyId } }, data: { status: 'CANCELLED' } });
  });
}

/**
 * Дневен напредък на изследванията (worker). Разходът се плаща всеки ден; без пари изследването спира.
 * Университет в седалището ускорява изследването. Първата завършила компания получава патент за 1 година.
 */
export async function processResearch(
  tx: Tx,
  project: { id: string; companyId: string | null; cityId: string | null; techId: string; progress: number; requiredDays: number; dailyCost: bigint },
  tick: number,
  hasUniversity: boolean,
) {
  const payer = project.companyId ? acc.company(project.companyId) : acc.city(project.cityId!);
  const pay = await tryTransfer(tx, {
    from: payer,
    to: SYS.WORLD,
    amount: project.dailyCost,
    kind: 'RESEARCH',
    tick,
    key: `research:${project.id}:${tick}`,
    refType: 'ResearchProject',
    refId: project.id,
  });
  if (pay.status === 'insufficient') return { completed: false, stalled: true };
  const speed = 1 + (hasUniversity ? BALANCE.research.universitySpeedup : 0);
  const progress = project.progress + speed;
  if (progress < project.requiredDays) {
    await tx.researchProject.update({ where: { id: project.id }, data: { progress } });
    return { completed: false, stalled: false };
  }
  const existing = await tx.patent.findUnique({ where: { techId: project.techId } });
  if (existing) {
    await tx.researchProject.update({ where: { id: project.id }, data: { progress, status: 'SUPERSEDED' } });
    return { completed: false, stalled: false };
  }
  const isPublic = !project.companyId;
  await tx.patent.create({
    data: {
      techId: project.techId,
      ownerCompanyId: project.companyId,
      public: isPublic,
      grantedTick: tick,
      expiresTick: tick + BALANCE.research.patentDays,
      licenseFee: 0n,
    },
  });
  await tx.researchProject.update({ where: { id: project.id }, data: { progress, status: 'COMPLETED' } });
  // Конкурентите, изследващи същата технология, спират.
  await tx.researchProject.updateMany({ where: { techId: project.techId, status: 'ACTIVE', id: { not: project.id } }, data: { status: 'SUPERSEDED' } });
  const t = TECHS[project.techId as TechId];
  await logEvent(tx, {
    tick,
    kind: 'patent',
    message: isPublic ? `Публично изследване завърши: „${t.name}“ е обществено достояние` : `Нов патент: „${t.name}“`,
  });
  return { completed: true, stalled: false };
}

/** Лицензионни такси (worker): лицензополучателят плаща дневна такса; без пари лицензът се прекратява. */
export async function processLicenses(tx: Tx, companyId: string, tick: number, userToNotify: string | null) {
  const licenses = await tx.license.findMany({ where: { companyId, status: 'ACTIVE' } });
  let paid = 0;
  for (const l of licenses) {
    const p = await tx.patent.findUnique({ where: { id: l.patentId } });
    if (!p || !p.ownerCompanyId || p.public || p.expiresTick <= tick) continue;
    if (p.licenseFee <= 0n) continue;
    const r = await tryTransfer(tx, {
      from: acc.company(companyId),
      to: acc.company(p.ownerCompanyId),
      amount: p.licenseFee,
      kind: 'LICENSE_FEE',
      tick,
      key: `license:${l.patentId}:${companyId}:${tick}`,
    });
    if (r.status === 'insufficient') {
      await tx.license.update({ where: { patentId_companyId: { patentId: l.patentId, companyId } }, data: { status: 'SUSPENDED' } });
      if (userToNotify) await notify(tx, userToNotify, 'license', `Лицензът за „${TECHS[p.techId as TechId].name}“ е спрян поради липса на средства`);
    } else paid += r.paid;
  }
  return paid;
}

export { transfer };
