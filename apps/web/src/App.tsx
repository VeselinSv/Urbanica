import { useEffect, useState } from 'react';
import { getToken, post, setToken, setUnauthorizedHandler } from './api';
import { refreshAll, setState, useStore } from './store';
import { connectSocket, disconnectSocket } from './socket';
import { Shell } from './ui/Shell';
import { Splash } from './ui/Brand';

/** Без регистрация и вход: при първо отваряне сървърът създава автоматичен играч (кмет). */
async function ensurePlayer() {
  if (!getToken()) {
    const r = await post<{ token: string }>('/auth/guest');
    setToken(r.token);
  }
  connectSocket();
  await refreshAll();
}

export function App() {
  const me = useStore((s) => s.me);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function boot() {
    setBooting(true);
    setError(null);
    try {
      await ensurePlayer();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBooting(false);
    }
  }

  useEffect(() => {
    // Изтекла/невалидна сесия (напр. нова база) → нов автоматичен играч, без екран за вход.
    let recovering = false;
    setUnauthorizedHandler(() => {
      if (recovering) return;
      recovering = true;
      setToken(null);
      disconnectSocket();
      setState({ me: null });
      void ensurePlayer()
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => (recovering = false));
    });
    void boot();
  }, []);

  if (booting || (!me && !error)) return <Splash />;
  if (error && !me)
    return (
      <div className="splash-error">
        <Splash text={`Няма връзка със сървъра: ${error}`} />
        <button className="btn primary" onClick={() => void boot()}>
          Опитай отново
        </button>
      </div>
    );
  return <Shell />;
}
