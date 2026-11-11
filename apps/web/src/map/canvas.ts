/**
 * Платно за рисуване, което работи и в главната нишка (HTMLCanvasElement), и в Web Worker (OffscreenCanvas).
 * Типът е HTMLCanvasElement, защото двата варианта имат еднакъв 2D контекст за нашите нужди.
 */
export function newCanvas(w = 1, h = 1): HTMLCanvasElement {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h) as unknown as HTMLCanvasElement;
}
