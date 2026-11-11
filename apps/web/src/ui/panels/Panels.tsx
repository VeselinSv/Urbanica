import { setState, useStore } from '../../store';
import { CityPanel, FinancePanel, InfraPanel, InspectPanel, PopulationPanel } from './CityPanels';
import { BankPanel, CompanyPanel, ContractsPanel, MarketPanel } from './EconomyPanels';
import { IssuesPanel } from './IssuesPanel';
import { AnalyticsPanel, ChatPanel, CorpPanel, DiplomacyPanel, EventsPanel, TechPanel } from './WorldPanels';

/** Всички панели (подраздели). */
export const PANEL_TABS = [
  { id: 'city', label: 'Общо', icon: '🏙' },
  { id: 'population', label: 'Население', icon: '👥' },
  { id: 'infra', label: 'Инфраструктура', icon: '⚡' },
  { id: 'issues', label: 'Сигнали', icon: '🚨' },
  { id: 'finance', label: 'Бюджет и данъци', icon: '💶' },
  { id: 'bank', label: 'Кредити', icon: '🏦' },
  { id: 'companies', label: 'Компании', icon: '🏭' },
  { id: 'market', label: 'Пазар', icon: '📈' },
  { id: 'contracts', label: 'Договори', icon: '📜' },
  { id: 'corp', label: 'Акции', icon: '📊' },
  { id: 'tech', label: 'Технологии', icon: '🔬' },
  { id: 'diplomacy', label: 'Съюзи', icon: '🤝' },
  { id: 'analytics', label: 'Анализи', icon: '📉' },
  { id: 'chat', label: 'Чат', icon: '💬' },
  { id: 'events', label: 'Събития', icon: '🔔' },
] as const;

/** Малко ясни раздели вместо 15 бутона – всеки раздел има подраздели. */
export const PANEL_GROUPS = [
  { id: 'g-city', label: 'Град', icon: '🏙', tabs: ['city', 'population', 'infra'] },
  { id: 'g-issues', label: 'Сигнали', icon: '🚨', tabs: ['issues'] },
  { id: 'g-money', label: 'Пари', icon: '💶', tabs: ['finance', 'bank'] },
  { id: 'g-biz', label: 'Бизнес', icon: '🏭', tabs: ['companies', 'market', 'contracts', 'corp', 'tech'] },
  { id: 'g-world', label: 'Свят', icon: '🌍', tabs: ['diplomacy', 'analytics', 'chat'] },
  { id: 'g-events', label: 'Събития', icon: '🔔', tabs: ['events'] },
] as const;

export function groupOf(panel: string) {
  return PANEL_GROUPS.find((g) => (g.tabs as readonly string[]).includes(panel)) ?? PANEL_GROUPS[0];
}

function SubTabs() {
  const panel = useStore((s) => s.panel);
  const g = groupOf(panel);
  if (g.tabs.length < 2) return null;
  return (
    <div className="subtabs" role="tablist">
      {g.tabs.map((id) => {
        const t = PANEL_TABS.find((x) => x.id === id)!;
        return (
          <button key={id} role="tab" aria-selected={panel === id} className={panel === id ? 'active' : ''} onClick={() => setState({ panel: id })}>
            {t.icon} {t.label}
          </button>
        );
      })}
    </div>
  );
}

function Panel() {
  const panel = useStore((s) => s.panel);
  switch (panel) {
    case 'city':
      return <CityPanel />;
    case 'issues':
      return <IssuesPanel />;
    case 'population':
      return <PopulationPanel />;
    case 'finance':
      return <FinancePanel />;
    case 'infra':
      return <InfraPanel />;
    case 'inspect':
      return <InspectPanel />;
    case 'companies':
      return <CompanyPanel />;
    case 'market':
      return <MarketPanel />;
    case 'contracts':
      return <ContractsPanel />;
    case 'bank':
      return <BankPanel />;
    case 'corp':
      return <CorpPanel />;
    case 'tech':
      return <TechPanel />;
    case 'diplomacy':
      return <DiplomacyPanel />;
    case 'analytics':
      return <AnalyticsPanel />;
    case 'chat':
      return <ChatPanel />;
    case 'events':
      return <EventsPanel />;
    default:
      return <CityPanel />;
  }
}

export function Panels() {
  return (
    <>
      <SubTabs />
      <Panel />
    </>
  );
}
