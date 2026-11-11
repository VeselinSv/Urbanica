/**
 * Корпоративно управление: разграничение между собственост и контрол.
 * - Акционерите гласуват (тежест = брой акции) по предложения: емисия на акции, дивиденти,
 *   назначения/освобождаване, сливания, продажба на активи.
 * - CEO управлява оперативно: съоръжения, търговия, договори, изследвания, кредити, лицензи.
 * - MANAGER: оперативни действия без кредити, изследвания и лицензи.
 * - BOARD: може да внася предложения за гласуване.
 * Всеки акционер също може да внася предложения.
 */
export const COMPANY_ROLES = ['CEO', 'MANAGER', 'BOARD'] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];

export const COMPANY_ACTIONS = ['operate', 'trade', 'contract', 'research', 'borrow', 'propose', 'license'] as const;
export type CompanyAction = (typeof COMPANY_ACTIONS)[number];

export const ROLE_PERMISSIONS: Record<CompanyRole, CompanyAction[]> = {
  CEO: ['operate', 'trade', 'contract', 'research', 'borrow', 'propose', 'license'],
  MANAGER: ['operate', 'trade', 'contract'],
  BOARD: ['propose'],
};

export function roleAllows(roles: readonly string[], action: CompanyAction): boolean {
  return roles.some((r) => (ROLE_PERMISSIONS as Record<string, CompanyAction[]>)[r]?.includes(action));
}

/** Праг за приемане на предложение – строго над 50% от тежестта на гласовете. */
export const PROPOSAL_THRESHOLD = 0.5;
export const PROPOSAL_TTL_DAYS = 10;
