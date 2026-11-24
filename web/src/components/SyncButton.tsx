import { useEffect, useState } from 'react';
import { api } from '../api.ts';

type Status = Awaited<ReturnType<typeof api.syncStatus>>;

function ago(iso: string): string {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** "Sync with bank" plus when it last happened and how recent the data is. Hidden until bank sync is linked. */
export function SyncButton({ lastDate, onSynced }: { lastDate: string | null; onSynced: () => Promise<void> }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { api.syncStatus().then(setStatus).catch(() => setStatus(null)); }, []);
  if (!status?.linked) return null;

  const sync = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.sync();
      setMsg(r.added ? `${r.added} new transaction${r.added === 1 ? '' : 's'}` : 'Up to date, nothing new');
      await onSynced();
      setStatus(await api.syncStatus());
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sync">
      <div className="small" style={{ textAlign: 'right' }}>
        <div>{msg ?? (status.lastSync ? `Synced ${ago(status.lastSync)}` : 'Never synced')}</div>
        <div className="muted">{lastDate ? `Transactions up to ${lastDate}` : ''}{status.daysLeft !== null && status.daysLeft < 14 ? ` · bank access ends in ${status.daysLeft} days` : ''}</div>
      </div>
      <button className="primary" disabled={busy} onClick={sync} title="Fetch new transactions from Revolut (banks allow about 4 fetches a day)">
        {busy ? 'Syncing…' : '↻ Sync with bank'}
      </button>
    </div>
  );
}
