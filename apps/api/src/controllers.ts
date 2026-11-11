import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { User } from '@gce/database';
import {
  BuildFacilitySchema,
  BuildSchema,
  BuyParcelSchema,
  LinkSchema,
  ContractSchema,
  FACILITIES,
  FACILITY_TYPES,
  FoundCitySchema,
  FoundCompanySchema,
  GOODS,
  LoanRequestSchema,
  PlaceOrderSchema,
  PolicySchema,
  RepaySchema,
  SERVICES,
  TECHS,
  TransferSchema,
  ZONES,
  BALANCE,
  type FacilityType,
} from '@gce/shared';
import * as D from '@gce/domain';
import { z } from 'zod';
import { CurrentUser, IdemKey, Public, parse, prisma } from './common';

// ---------------------------------------------------------------- Автентикация
@Controller('auth')
export class AuthController {
  /** Без регистрация: първото отваряне създава автоматичен играч (кмет) и връща сесия. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('guest')
  guest() {
    return D.createGuest(prisma);
  }

  @Get('me')
  async me(@CurrentUser() user: User) {
    const wallet = await D.walletBalance(prisma, user.id);
    return { user: D.publicUser(user), wallet };
  }
}

// ---------------------------------------------------------------- Свят и каталог
@Controller()
export class WorldController {
  @Public()
  @Get('world')
  world() {
    return D.worldInfo(prisma);
  }

  @Public()
  @Get('catalog')
  catalog() {
    return { goods: GOODS, zones: ZONES, services: SERVICES, facilities: FACILITIES, techs: TECHS, balance: BALANCE };
  }

  @Public()
  @Get('world/region')
  region(@Query() q: Record<string, string>) {
    const n = (v: string) => Math.max(0, Math.min(BALANCE.world.size - 1, Number(v) || 0));
    return D.region(prisma, n(q.x0), n(q.y0), n(q.x1), n(q.y1));
  }

  @Public()
  @Get('world/links')
  links() {
    return D.listLinks(prisma);
  }

  @Public()
  @Get('world/parcel-price')
  async parcelPrice(@Query() q: Record<string, string>) {
    const gen = await D.worldGen(prisma);
    const city = await prisma.city.findUnique({ where: { id: String(q.cityId) }, include: { parcels: true } });
    const px = Number(q.px);
    const py = Number(q.py);
    return { price: D.parcelPrice(gen, px, py, city?.parcels.length ?? 9), profile: gen.parcelProfile(px, py) };
  }

  @Public()
  @Get('news')
  news() {
    return D.news(prisma);
  }

  @Public()
  @Get('analytics/overview')
  overview() {
    return D.worldOverview(prisma);
  }

  @Public()
  @Get('analytics/leaderboard')
  leaderboard() {
    return D.leaderboard(prisma);
  }

  @Get('analytics/invest')
  invest(@Query() q: Record<string, string>) {
    const type = q.type as FacilityType;
    if (!(FACILITY_TYPES as readonly string[]).includes(type)) return { error: 'type' };
    return D.simulateInvestment(prisma, { cityId: q.cityId, type, x: q.x ? Number(q.x) : undefined, y: q.y ? Number(q.y) : undefined });
  }

  @Get('wallet')
  async wallet(@CurrentUser() user: User) {
    return { balance: await D.walletBalance(prisma, user.id), history: await D.accountHistory(prisma, D.acc.user(user.id)) };
  }
}

// ---------------------------------------------------------------- Градове
@Controller('cities')
export class CityController {
  @Get()
  list(@Query('mine') mine: string, @CurrentUser() user: User) {
    return D.listCities(prisma, mine === '1' ? user.id : undefined);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  found(@Body() body: unknown, @CurrentUser() user: User) {
    const b = parse(FoundCitySchema, body);
    return D.foundCity(prisma, user.id, b.name, b.x !== undefined && b.y !== undefined ? { x: b.x, y: b.y } : undefined);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: User) {
    return D.getCity(prisma, id, user.id);
  }

  @Get(':id/issues')
  issues(@Param('id') id: string, @CurrentUser() user: User) {
    return D.listIssues(prisma, user.id, id);
  }

  @Post(':id/issues/:issueId/fix')
  fixIssue(@Param('id') id: string, @Param('issueId') issueId: string, @CurrentUser() user: User, @IdemKey() key?: string) {
    return D.fixIssue(prisma, user.id, id, issueId, key);
  }

  @Get(':id/layers')
  layers(@Param('id') id: string, @CurrentUser() user: User) {
    return D.cityLayers(prisma, id, user.id);
  }

  @Get(':id/history')
  history(@Param('id') id: string, @Query('days') days: string, @CurrentUser() user: User) {
    return D.cityHistory(prisma, id, user.id, Number(days) || 120);
  }

  @Get(':id/events')
  events(@Param('id') id: string) {
    return D.cityEvents(prisma, id);
  }

  @Get(':id/finance')
  async finance(@Param('id') id: string, @CurrentUser() user: User) {
    const c = await prisma.city.findUnique({ where: { id }, select: { ownerId: true } });
    if (!c || c.ownerId !== user.id) throw new D.DomainError('FORBIDDEN', 'Финансите на града са поверителни', 403);
    return { history: await D.accountHistory(prisma, D.acc.city(id), 80), credit: await D.loanOffer(prisma, 'CITY', id) };
  }

  @Post(':id/build')
  build(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: User, @IdemKey() key?: string) {
    return D.build(prisma, user.id, id, parse(BuildSchema, body), key);
  }

  @Post(':id/undo')
  undo(@Param('id') id: string, @CurrentUser() user: User) {
    return D.undoBuild(prisma, user.id, id);
  }

  @Post(':id/links')
  buildLink(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: User, @IdemKey() key?: string) {
    return D.buildLink(prisma, user.id, id, parse(LinkSchema, body).toCityId, key);
  }

  @Post(':id/parcels')
  buyParcel(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: User, @IdemKey() key?: string) {
    const b = parse(BuyParcelSchema, body);
    return D.buyParcel(prisma, user.id, id, b.px, b.py, key);
  }

  @Patch(':id/policy')
  policy(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: User) {
    return D.setPolicy(prisma, user.id, id, parse(PolicySchema, body));
  }

  @Post(':id/funding')
  fund(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: User, @IdemKey() key?: string) {
    const b = parse(TransferSchema, { ...(body as object), cityId: id });
    return D.walletToCity(prisma, user.id, id, b.amount, key);
  }

  @Post(':id/public-research')
  publicResearch(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: User) {
    const b = parse(z.object({ techId: z.enum(Object.keys(TECHS) as [keyof typeof TECHS]) }), body);
    return D.startPublicResearch(prisma, user.id, id, b.techId);
  }
}

// ---------------------------------------------------------------- Компании
@Controller('companies')
export class CompanyController {
  @Get()
  list() {
    return D.listCompanies(prisma);
  }

  @Get('mine')
  mine(@CurrentUser() user: User) {
    return D.myCompanies(prisma, user.id);
  }

  @Post()
  found(@Body() body: unknown, @CurrentUser() user: User, @IdemKey() key?: string) {
    return D.foundCompany(prisma, user.id, parse(FoundCompanySchema, body), key);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: User) {
    return D.getCompany(prisma, id, user.id);
  }

  @Post(':id/facilities')
  facility(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: User, @IdemKey() key?: string) {
    return D.buildFacility(prisma, user.id, id, parse(BuildFacilitySchema, body), key);
  }

  @Post('facilities/:fid/upgrade')
  upgrade(@Param('fid') fid: string, @CurrentUser() user: User) {
    return D.upgradeFacility(prisma, user.id, fid);
  }

  @Post(':id/research')
  research(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: User) {
    const b = parse(z.object({ techId: z.enum(Object.keys(TECHS) as [keyof typeof TECHS]) }), body);
    return D.startResearch(prisma, user.id, id, b.techId);
  }

  @Get(':id/ledger')
  async ledger(@Param('id') id: string, @CurrentUser() user: User) {
    const roles = await D.rolesOf(prisma, id, user.id);
    if (!roles.length) throw new D.DomainError('FORBIDDEN', 'Счетоводните записи са достъпни за ръководството', 403);
    return D.accountHistory(prisma, D.acc.company(id), 80);
  }
}

// ---------------------------------------------------------------- Пазар
@Controller('market')
export class MarketController {
  @Public()
  @Get('summary')
  summary() {
    return D.marketSummary(prisma);
  }

  @Public()
  @Get('book/:instrument')
  book(@Param('instrument') instrument: string) {
    return D.orderBook(prisma, instrument);
  }

  @Get('orders')
  mine(@CurrentUser() user: User) {
    return D.myOrders(prisma, user.id);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('orders')
  place(@Body() body: unknown, @CurrentUser() user: User, @IdemKey() key?: string) {
    return D.placeOrder(prisma, user.id, parse(PlaceOrderSchema, body), key);
  }

  @Delete('orders/:id')
  cancel(@Param('id') id: string, @CurrentUser() user: User) {
    if (!/^\d+$/.test(id)) throw new D.DomainError('BAD_REQUEST', 'Невалиден идентификатор', 400);
    return D.cancelOrder(prisma, user.id, id);
  }
}

// ---------------------------------------------------------------- Договори
@Controller('contracts')
export class ContractController {
  @Get()
  list(@CurrentUser() user: User) {
    return D.listContracts(prisma, user.id);
  }

  @Post()
  propose(@Body() body: unknown, @CurrentUser() user: User) {
    return D.proposeContract(prisma, user.id, parse(ContractSchema, body));
  }

  @Post(':id/:action')
  respond(@Param('id') id: string, @Param('action') action: string, @CurrentUser() user: User) {
    if (!['accept', 'reject', 'cancel', 'terminate'].includes(action)) throw new D.DomainError('BAD_REQUEST', 'Невалидно действие', 400);
    return D.respondContract(prisma, user.id, id, action as 'accept');
  }
}

// ---------------------------------------------------------------- Банка
@Controller('bank')
export class BankController {
  @Get('offer')
  offer(@Query('type') type: string, @Query('id') id: string) {
    if (type !== 'COMPANY' && type !== 'CITY') throw new D.DomainError('BAD_REQUEST', 'type', 400);
    return D.loanOffer(prisma, type, id);
  }

  @Get('loans')
  loans(@CurrentUser() user: User) {
    return D.listLoans(prisma, user.id);
  }

  @Post('loans')
  take(@Body() body: unknown, @CurrentUser() user: User, @IdemKey() key?: string) {
    return D.takeLoan(prisma, user.id, parse(LoanRequestSchema, body), key);
  }

  @Post('loans/:id/repay')
  repay(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: User, @IdemKey() key?: string) {
    return D.repayLoan(prisma, user.id, id, parse(RepaySchema, body).amount, key);
  }

  @Post('loans/:id/restructure')
  restructure(@Param('id') id: string, @CurrentUser() user: User) {
    return D.restructureLoan(prisma, user.id, id);
  }
}
