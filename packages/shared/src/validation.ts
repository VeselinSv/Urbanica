import { z } from 'zod';
import { ECON } from './scale';
import { FACILITY_TYPES, GOOD_IDS, SERVICE_TYPES, TECH_IDS, ZONE_TYPES } from './catalog';
import { BALANCE } from './balance';
import { JUNCTION_TYPES, ROAD_CLASSES } from './types';

const L = BALANCE.taxes.limits;
const coord = z
  .number()
  .int()
  .min(0)
  .max(BALANCE.world.size - 1);
const tile = z.object({ x: coord, y: coord });
const id = z.string().min(1).max(64);
const money = z.number().int().positive().max(1e14);

export const RegisterSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(24)
    .regex(/^[A-Za-z0-9_-]+$/, 'Позволени са латински букви, цифри, _ и -'),
  email: z.string().trim().email().max(120),
  password: z.string().min(8).max(128),
});
export const LoginSchema = z.object({ login: z.string().trim().min(3).max(120), password: z.string().min(1).max(128) });
export const ResetRequestSchema = z.object({ email: z.string().trim().email() });
export const ResetConfirmSchema = z.object({ token: z.string().min(10).max(200), password: z.string().min(8).max(128) });

export const FoundCitySchema = z.object({
  name: z.string().trim().min(2).max(40),
  x: coord.optional(),
  y: coord.optional(),
});

export const BuildSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('road'), roadClass: z.enum(ROAD_CLASSES).optional(), tiles: z.array(tile).min(1).max(400) }),
  /** Тротоари: върху път добавя (или с remove – премахва) тротоари; върху празна земя прави пешеходна алея. */
  /** Автобусна спирка върху път (без кръстовище); remove – премахва. */
  z.object({ action: z.literal('busstop'), remove: z.boolean().optional(), tiles: z.array(tile).min(1).max(50) }),
  z.object({ action: z.literal('sidewalk'), remove: z.boolean().optional(), tiles: z.array(tile).min(1).max(400) }),
  z.object({ action: z.literal('junction'), control: z.enum([...JUNCTION_TYPES, 'none']), tiles: z.array(tile).min(1).max(50) }),
  z.object({ action: z.literal('zone'), zone: z.enum(ZONE_TYPES), tiles: z.array(tile).min(1).max(400) }),
  z.object({ action: z.literal('dezone'), tiles: z.array(tile).min(1).max(400) }),
  z.object({ action: z.literal('service'), service: z.enum(SERVICE_TYPES), tiles: z.array(tile).length(1) }),
  z.object({ action: z.literal('bulldoze'), tiles: z.array(tile).min(1).max(400) }),
]);
export type BuildInput = z.infer<typeof BuildSchema>;

export const LinkSchema = z.object({ toCityId: z.string().min(5).max(40) });

export const BuyParcelSchema = z.object({ px: z.number().int().min(0), py: z.number().int().min(0) });

const rate = (r: readonly [number, number]) => z.number().min(r[0]).max(r[1]);
export const PolicySchema = z.object({
  taxes: z
    .object({
      income: rate(L.income),
      property: rate(L.property),
      corporate: rate(L.corporate),
      sales: rate(L.sales),
      resource: rate(L.resource),
      pollution: rate(L.pollution),
    })
    .partial()
    .optional(),
  serviceBudget: z.number().min(0.5).max(1.5).optional(),
  subsidies: z
    .partialRecord(
      z.enum(ZONE_TYPES),
      z
        .number()
        .int()
        .min(0)
        .max(5_000 * ECON),
    )
    .optional(),
  powerTariff: z.number().int().min(BALANCE.utilities.tariffLimits.power[0]).max(BALANCE.utilities.tariffLimits.power[1]).optional(),
  waterTariff: z.number().int().min(BALANCE.utilities.tariffLimits.water[0]).max(BALANCE.utilities.tariffLimits.water[1]).optional(),
  importTariff: z.number().min(0).max(0.5).optional(),
  sanctions: z.array(id).max(100).optional(),
  powerPriority: z
    .array(z.enum(['services', 'facilities', 'zones']))
    .length(3)
    .optional(),
});
export type PolicyInput = z.infer<typeof PolicySchema>;

export const FoundCompanySchema = z.object({
  name: z.string().trim().min(2).max(40),
  hqCityId: id,
  capital: money.min(BALANCE.company.minFoundingCapital),
});
export const BuildFacilitySchema = z.object({ cityId: id, type: z.enum(FACILITY_TYPES), x: coord, y: coord });
export const CapitalInjectionSchema = z.object({ amount: money });

export const PlaceOrderSchema = z
  .object({
    instrument: z.string().regex(/^(GOOD:[a-z_]+|SHARE:[A-Za-z0-9_-]+)$/),
    side: z.enum(['BUY', 'SELL']),
    quantity: z.number().int().positive().max(BALANCE.market.orderMaxQty),
    price: z.number().int().positive().max(1e10),
    /** За стоки: компанията, която търгува; за акции: празно = личен портфейл. */
    companyId: id.optional(),
    /** Град-локация на склада (продажба) или дестинация (покупка). */
    cityId: id.optional(),
  })
  .refine((o) => !o.instrument.startsWith('GOOD:') || (GOOD_IDS as readonly string[]).includes(o.instrument.slice(5)), 'Непозната стока')
  .refine((o) => !o.instrument.startsWith('GOOD:') || Boolean(o.companyId && o.cityId), 'За стоки са нужни companyId и cityId');

export const ContractSchema = z.object({
  sellerCompanyId: id,
  buyerCompanyId: id,
  good: z.enum(GOOD_IDS),
  quantityPerDelivery: z.number().int().positive().max(100_000),
  pricePerUnit: z.number().int().positive().max(1e9),
  intervalDays: z.number().int().min(1).max(90),
  deliveries: z.number().int().min(1).max(120),
  penaltyPerMiss: z.number().int().min(0).max(1e10),
  fromCityId: id,
  toCityId: id,
});

export const LoanRequestSchema = z.object({
  borrowerType: z.enum(['COMPANY', 'CITY']),
  borrowerId: id,
  amount: money,
  termDays: z.number().int().min(30).max(1080),
});
export const RepaySchema = z.object({ amount: money });

export const PROPOSAL_KINDS = [
  'ISSUE_SHARES',
  'PAY_DIVIDEND',
  'APPOINT_ROLE',
  'REMOVE_ROLE',
  'MERGE_INTO',
  'SELL_FACILITY',
  'ALLIANCE_KICK',
  'ALLIANCE_SANCTION',
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const ProposalSchema = z.object({
  scopeType: z.enum(['COMPANY', 'ALLIANCE']),
  scopeId: id,
  kind: z.enum(PROPOSAL_KINDS),
  payload: z.record(z.string(), z.unknown()),
});
export const VoteSchema = z.object({ approve: z.boolean() });

export const ResearchSchema = z.object({ techId: z.enum(TECH_IDS) });
export const PublicResearchSchema = z.object({ techId: z.enum(TECH_IDS) });
export const LicenseFeeSchema = z.object({ dailyFee: z.number().int().min(0).max(1e9) });
export const LicenseRequestSchema = z.object({ companyId: id });

export const AllianceSchema = z.object({ name: z.string().trim().min(2).max(40), description: z.string().max(400).default('') });
export const InviteSchema = z.object({ username: z.string().min(3).max(24) });

export const ChatSchema = z.object({
  channel: z.string().regex(/^(global|dm:[A-Za-z0-9_-]+|company:[A-Za-z0-9_-]+|alliance:[A-Za-z0-9_-]+)$/),
  body: z.string().trim().min(1).max(BALANCE.chat.maxLength),
});
export const ReportSchema = z.object({ userId: id, reason: z.string().trim().min(3).max(500), messageId: id.optional() });
export const TransferSchema = z.object({ cityId: id, amount: money });
export const FriendSchema = z.object({ username: z.string().min(3).max(24) });

export function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.map(String).join('.') || 'вход'}: ${i.message}`).join('; ');
}
