/**
 * Бранд „Urbanica“ – игра на Веселин Стоянов.
 * Знак: две изометрични кули върху парцел, които оформят буквата U, с изгряващо слънце.
 */
export const BRAND = {
  name: 'Urbanica',
  tagline: 'Построй държава от нулата',
  author: 'Веселин Стоянов',
  year: 2026,
};

export function LogoMark({ size = 36, title = 'Urbanica' }: { size?: number; title?: string }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      <defs>
        <linearGradient id="ub-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0d1b33" />
          <stop offset="1" stopColor="#0a1222" />
        </linearGradient>
        <linearGradient id="ub-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2dd4bf" />
          <stop offset="0.55" stopColor="#a3e635" />
          <stop offset="1" stopColor="#fbbf24" />
        </linearGradient>
        <radialGradient id="ub-sun" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#fde68a" />
          <stop offset="1" stopColor="#f59e0b" />
        </radialGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="17" fill="url(#ub-bg)" stroke="url(#ub-ring)" strokeWidth="2.5" />
      <circle cx="47" cy="15" r="5.5" fill="url(#ub-sun)" />
      {/* парцел */}
      <polygon points="9,43 32,31.5 55,43 32,54.5" fill="#1e3a5f" />
      <polygon points="9,43 32,54.5 32,57 9,45.5" fill="#132a46" />
      <polygon points="55,43 32,54.5 32,57 55,45.5" fill="#0f2038" />
      {/* лява (висока) кула */}
      <polygon points="12,19 20,23 20,47 12,43" fill="#0f9e8f" />
      <polygon points="20,23 28,19 28,43 20,47" fill="#2dd4bf" />
      <polygon points="12,19 20,15 28,19 20,23" fill="#99f6e4" />
      {/* дясна кула */}
      <polygon points="36,27 44,31 44,47 36,43" fill="#5d9a10" />
      <polygon points="44,31 52,27 52,43 44,47" fill="#a3e635" />
      <polygon points="36,27 44,23 52,27 44,31" fill="#ecfccb" />
      {/* прозорци */}
      <g fill="#0b1324" opacity="0.55">
        <polygon points="22,27 26,25 26,27 22,29" />
        <polygon points="22,32 26,30 26,32 22,34" />
        <polygon points="22,37 26,35 26,37 22,39" />
        <polygon points="46,34 50,32 50,34 46,36" />
        <polygon points="46,39 50,37 50,39 46,41" />
      </g>
    </svg>
  );
}

export function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <span className="wordmark" style={{ fontSize: size }}>
      URBANICA
    </span>
  );
}

/** Знак + име (+ автор). */
export function BrandLockup({ size = 36, author = false }: { size?: number; author?: boolean }) {
  return (
    <span className="brand-lockup">
      <LogoMark size={size} />
      <span className="brand-text">
        <Wordmark size={size * 0.5} />
        {author && <span className="brand-author">by {BRAND.author}</span>}
      </span>
    </span>
  );
}

export function AuthorCredit({ className = '' }: { className?: string }) {
  return (
    <p className={`author-credit ${className}`}>
      Игра, създадена от <b>{BRAND.author}</b> · © {BRAND.year}
    </p>
  );
}

/** Екран при зареждане – логото пулсира. */
export function Splash({ text = 'Зареждане на света…' }: { text?: string }) {
  return (
    <div className="splash">
      <div className="splash-logo">
        <LogoMark size={96} />
      </div>
      <Wordmark size={34} />
      <p className="splash-tagline">{BRAND.tagline}</p>
      <p className="splash-status">{text}</p>
      <AuthorCredit />
    </div>
  );
}
