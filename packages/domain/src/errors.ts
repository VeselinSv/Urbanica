/** Домейн грешка с машинен код и HTTP статус – API слоят я превръща в отговор. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new DomainError('NOT_FOUND', `${what} не е намерен(а)`, 404);
export const forbidden = (msg = 'Нямате права за това действие') => new DomainError('FORBIDDEN', msg, 403);
export const conflict = (msg: string) => new DomainError('CONFLICT', msg, 409);
export const bad = (msg: string) => new DomainError('BAD_REQUEST', msg, 400);
export const insufficient = (msg = 'Недостатъчни средства') => new DomainError('INSUFFICIENT_FUNDS', msg, 402);

export function assert(cond: unknown, err: DomainError): asserts cond {
  if (!cond) throw err;
}
