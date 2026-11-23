import { useCallback, useEffect, useState } from 'react';
import { api, type Category, type Summary } from './api.ts';
import { ImportPage } from './pages/Import.tsx';
import { Inbox } from './pages/Inbox.tsx';
import { Overview } from './pages/Overview.tsx';
import { Rules } from './pages/Rules.tsx';
import { Splits } from './pages/Splits.tsx';
import { Transactions } from './pages/Transactions.tsx';

export interface AppData {
  summary: Summary | null;
  categories: Category[];
  refresh: () => Promise<void>;
  navigate: (route: string) => void;
}

const PAGES = [
  ['overview', 'Overview'],
  ['inbox', 'Label'],
  ['transactions', 'Transactions'],
  ['splits', 'Splits'],
  ['rules', 'Rules'],
  ['import', 'Import & settings'],
] as const;

function currentRoute() {
  return location.hash.replace(/^#\/?/, '') || 'overview';
}

export function App() {
  const [route, setRoute] = useState(currentRoute);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);

  const refresh = useCallback(async () => {
    const [s, c] = await Promise.all([api.summary(), api.categories()]);
    setSummary(s);
    setCategories(c);
  }, []);

  useEffect(() => {
    refresh();
    const onHash = () => setRoute(currentRoute());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, [refresh]);

  const navigate = (r: string) => { location.hash = '/' + r; };
  const data: AppData = { summary, categories, refresh, navigate };
  const [page, query] = route.split('?') as [string, string | undefined];
  const uncategorized = summary?.counts.uncategorized ?? 0;

  return (
    <div className="layout">
      <nav>
        <div className="brand">spendlens</div>
        {PAGES.map(([id, label]) => (
          <a key={id} href={`#/${id}`} className={page === id ? 'active' : ''}>
            {label}
            {id === 'inbox' && uncategorized > 0 && <span className="badge">{uncategorized}</span>}
          </a>
        ))}
      </nav>
      <main>
        {summary && summary.counts.total === 0 && page !== 'import' ? (
          <div className="card">
            <h1>Welcome</h1>
            <p className="sub">No transactions yet. Import a Revolut statement CSV to get started.</p>
            <button className="primary" onClick={() => navigate('import')}>Import a statement</button>
          </div>
        ) : page === 'inbox' ? <Inbox {...data} />
          : page === 'transactions' ? <Transactions {...data} query={new URLSearchParams(query)} />
          : page === 'splits' ? <Splits {...data} />
          : page === 'rules' ? <Rules {...data} />
          : page === 'import' ? <ImportPage {...data} />
          : <Overview {...data} />}
      </main>
    </div>
  );
}
