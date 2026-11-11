import { gameDate } from '@gce/shared';

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '—';
  const v = cents / 100;
  const abs = Math.abs(v);
  const s = abs >= 1e6 ? `${(abs / 1e6).toFixed(2)} млн` : abs >= 1e4 ? `${(abs / 1e3).toFixed(1)} хил` : abs.toFixed(abs < 100 ? 2 : 0);
  return `${v < 0 ? '−' : ''}${s} €`;
}

export const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)}%`);
export const num = (v: number | null | undefined) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString('bg-BG'));
export const dateLabel = (tick: number) => gameDate(tick).label;

/** Превръща € (въведени от потребителя) в центове. */
export const toCents = (gc: number) => Math.round(gc * 100);

export const RATING_COLOR: Record<string, string> = {
  AAA: '#22c55e',
  AA: '#4ade80',
  A: '#a3e635',
  BBB: '#facc15',
  BB: '#fb923c',
  B: '#f97316',
  CCC: '#ef4444',
  D: '#b91c1c',
};

export const KIND_LABELS: Record<string, string> = {
  CITY_INCOME_TAX: 'Данък доход',
  CITY_PROPERTY_TAX: 'Данък имоти',
  CITY_CORPORATE_TAX_ZONED: 'Корп. данък (зони)',
  CITY_SALES_TAX: 'Данък продажби',
  CITY_UTILITY_FEES: 'Комунални такси',
  CITY_ROAD_UPKEEP: 'Поддръжка пътища',
  CITY_SERVICE_UPKEEP: 'Поддръжка услуги',
  CITY_SERVICE_WAGES: 'Заплати услуги',
  CITY_FUEL: 'Гориво',
  CITY_SUBSIDIES: 'Субсидии',
  CONSTRUCTION: 'Строителство',
  CONSTRUCTION_REFUND: 'Отменено строителство (възстановени)',
  ISSUE_FIX: 'Ремонтни екипи (сигнали)',
  LAND_PURCHASE: 'Покупка на земя',
  START_CAPITAL: 'Начален капитал',
  ENERGY_SALE: 'Продажба на енергия',
  WAGES: 'Заплати',
  UPKEEP: 'Поддръжка',
  UTILITIES: 'Комунални',
  POLLUTION_FEE: 'Екотакса',
  RESOURCE_FEE: 'Ресурсна такса',
  TRADE_PROCEEDS: 'Продажба (борса)',
  RETAIL_SALE: 'Продажба на дребно',
  EXPORT_SALE: 'Износ',
  ORDER_ESCROW: 'Ескроу поръчка',
  ESCROW_REFUND: 'Възстановен ескроу',
  LOAN_DISBURSEMENT: 'Кредит',
  LOAN_PAYMENT: 'Вноска по кредит',
  LOAN_PREPAYMENT: 'Предсрочно плащане',
  CORPORATE_TAX: 'Корпоративен данък',
  DIVIDEND: 'Дивидент',
  CAPITAL_CONTRIBUTION: 'Капитал',
  FACILITY_CONSTRUCTION: 'Строеж на съоръжение',
  RESEARCH: 'Изследвания',
  LICENSE_FEE: 'Лицензи',
  SHIPPING: 'Транспорт',
  IMPORT_TARIFF: 'Мито',
  SALES_TAX: 'Данък продажби',
  CONTRACT_PAYMENT: 'Плащане по договор',
  CONTRACT_PENALTY: 'Неустойка',
  WALLET_TO_CITY: 'Превод от портфейла',
  CITY_FOUNDING: 'Основаване на град',
  SHARE_ISSUE: 'Емисия акции',
  ASSET_SALE: 'Продажба на актив',
};
