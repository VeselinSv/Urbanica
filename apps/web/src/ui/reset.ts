import { BALANCE } from '@gce/shared';
import { post } from '../api';
import { bumpData, refreshAll, setState, toast } from '../store';
import { money } from '../format';

/** „Започни отначало“: пита за потвърждение, изтрива градовете и компаниите на играча и връща стартовия капитал. */
export async function resetGame() {
  const ok = window.confirm(
    `Започвате отначало?\n\nВсичките ви градове и компании ще бъдат изтрити. Получавате отново ${money(BALANCE.start.wallet)} в портфейла и ${money(
      BALANCE.start.cityTreasury,
    )} за нов град.\n\nТова не може да се отмени.`,
  );
  if (!ok) return;
  const r = await post<{ cities: number; companies: number }>('/auth/reset', {});
  toast(`Нова игра: изтрити ${r.cities} града и ${r.companies} компании. Изберете място за нов град.`, 'success');
  setState({ city: null, tool: { kind: 'found', name: '' }, tutorial: 0, panelOpen: false });
  await refreshAll();
  bumpData();
}
