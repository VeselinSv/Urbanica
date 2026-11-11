import { useEffect, useState } from 'react';
import { setState, useStore } from '../store';

/** Кратко въведение (6 стъпки) – показва се при първо влизане; бутонът „?“ на картата го отваря отново. */
const STEPS: { title: string; text: string; target?: string }[] = [
  {
    title: 'Добре дошли в Urbanica',
    text: 'Построявате град от нулата в реалната България. Ето за минута най-важното – после можете да го отворите отново с бутона „?“ до картата.',
  },
  {
    title: '1. Изберете място',
    text: 'Натиснете „Избери място“ и щракнете върху картата. Зеленото поле показва подходящо място – получавате земя и стартов капитал.',
    target: '.advisor',
  },
  {
    title: '2. Път, после зони',
    text: 'От „Пътища“ влачете улица. После от „Зони“ оградете жилища до пътя – къщите се строят сами, щом има ток (централа) и вода (помпа).',
    target: '.toolbar',
  },
  {
    title: '3. Какво трябва на сградите',
    text: 'Значките ⚡ 💧 🛣 🚶 над сградите показват какво им липсва. Посочете сграда за кратка информация или щракнете за списък ✔/✖ с бутони „Строй“.',
    target: '.map-host',
  },
  {
    title: '4. Управление на града',
    text: 'Отдясно са бюджетът, данъците, сигналите от гражданите (дупки, аварии…), бизнесът и светът. „Следваща стъпка“ горе винаги подсказва какво да направите.',
    target: '.side-tabs',
  },
  {
    title: '5. Картата',
    text: 'Мащаб, цяла България, граници, ↶ отмяна на последното строене (Ctrl+Z, връща и парите) и този помощник. Горе вдясно – ден/нощ, сезон и времето.',
    target: '.map-zoom',
  },
];

export function Tutorial() {
  const step = useStore((s) => s.tutorial);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const cur = step === null ? null : STEPS[step];
  useEffect(() => {
    if (!cur?.target) {
      setRect(null);
      return;
    }
    const el = document.querySelector(cur.target);
    setRect(el ? el.getBoundingClientRect() : null);
  }, [cur]);
  if (step === null || !cur) return null;
  const close = () => {
    try {
      localStorage.setItem('gce_tutorial_done', '1');
    } catch {
      /* без запис */
    }
    setState({ tutorial: null });
  };
  const last = step === STEPS.length - 1;
  return (
    <div className="tutorial" role="dialog" aria-modal="true" aria-label="Въведение">
      {rect && <div className="tut-ring" style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }} />}
      <div className="tut-card glass">
        <div className="tut-dots">
          {STEPS.map((_, i) => (
            <i key={i} className={i === step ? 'on' : ''} />
          ))}
        </div>
        <h3>{cur.title}</h3>
        <p>{cur.text}</p>
        <div className="tut-actions">
          <button className="btn ghost small" onClick={close}>
            Пропусни
          </button>
          {step > 0 && (
            <button className="btn small" onClick={() => setState({ tutorial: step - 1 })}>
              Назад
            </button>
          )}
          <button className="btn primary small" onClick={() => (last ? close() : setState({ tutorial: step + 1 }))}>
            {last ? 'Да започваме!' : 'Напред'}
          </button>
        </div>
      </div>
    </div>
  );
}
