import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { AppData } from '../App.tsx';

export function ImportPage({ refresh, categories, navigate }: AppData) {
  const [over, setOver] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imports, setImports] = useState<Awaited<ReturnType<typeof api.imports>>>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [newCat, setNewCat] = useState('');

  useEffect(() => { api.imports().then(setImports); api.settings().then(setSettings); }, []);

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    for (const f of Array.from(files)) {
      setStatus(`Importing ${f.name}…`);
      try {
        const r = await api.importCsv(await f.text(), f.name);
        setStatus(`${f.name}: ${r.added} new, ${r.updated} updated, ${r.unchanged} already imported.`);
      } catch (e) { setError(`${f.name}: ${(e as Error).message}`); setStatus(null); }
    }
    await refresh();
    setImports(await api.imports());
  };

  return (
    <>
      <h1>Import & settings</h1>
      <BankSync onSynced={async () => { await refresh(); setImports(await api.imports()); }} />
      <div className="card">
        <h2>Import a Revolut statement</h2>
        <p className="muted small">In the Revolut app: <b>Accounts → ⋯ → Statement → Excel/CSV</b>, pick a period, download. Re-importing overlapping periods is safe; duplicates are skipped and pending transactions get updated.</p>
        <label className={`dropzone ${over ? 'over' : ''}`} style={{ display: 'block', cursor: 'pointer' }}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); importFiles(e.dataTransfer.files); }}>
          Drop CSV files here, or click to choose
          <input type="file" accept=".csv,text/csv" multiple hidden onChange={(e) => importFiles(e.target.files)} />
        </label>
        {status && <p>{status} <a href="#/inbox" onClick={(e) => { e.preventDefault(); navigate('inbox'); }}>Label merchants →</a></p>}
        {error && <p className="error">{error}</p>}
        {imports.length > 0 && (
          <table style={{ marginTop: 12 }}>
            <thead><tr><th>When</th><th>File</th><th className="num">New</th><th className="num">Updated</th></tr></thead>
            <tbody>{imports.slice(0, 10).map((i) => <tr key={i.id}><td className="small">{i.at}</td><td>{i.label ?? i.source}</td><td className="num">{i.added}</td><td className="num">{i.updated}</td></tr>)}</tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Settings</h2>
        <div className="row">
          <label>Base currency&nbsp;
            <input type="text" style={{ width: 70 }} value={settings.base_currency ?? 'EUR'}
              onChange={(e) => setSettings({ ...settings, base_currency: e.target.value.toUpperCase() })}
              onBlur={async () => { await api.saveSettings({ base_currency: settings.base_currency ?? 'EUR' }); refresh(); }} />
          </label>
          <span className="muted small">Reports only include transactions in this currency.</span>
        </div>
      </div>

      <div className="card">
        <h2>Categories</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <input type="text" placeholder="New category" value={newCat} onChange={(e) => setNewCat(e.target.value)} />
          <button disabled={!newCat} onClick={async () => { await api.addCategory({ name: newCat, isIncome: false }); setNewCat(''); refresh(); }}>Add spending category</button>
          <button disabled={!newCat} onClick={async () => { await api.addCategory({ name: newCat, isIncome: true }); setNewCat(''); refresh(); }}>Add income category</button>
        </div>
        <table>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id}>
                <td>
                  <input type="text" defaultValue={c.name} onBlur={async (e) => { if (e.target.value && e.target.value !== c.name) { await api.updateCategory(c.id, { name: e.target.value }); refresh(); } }} />
                </td>
                <td className="muted small">{c.isIncome ? 'income' : 'spending'}</td>
                <td><button className="ghost small" onClick={async () => { if (confirm(`Delete "${c.name}"? Its transactions become uncategorized.`)) { await api.deleteCategory(c.id); refresh(); } }}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function BankSync({ onSynced }: { onSynced: () => Promise<void> }) {
  const [s, setS] = useState<Awaited<ReturnType<typeof api.syncStatus>> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.syncStatus().then(setS); }, []);
  if (!s) return null;
  return (
    <div className="card">
      <h2>Automatic bank sync</h2>
      {!s.linked ? (
        <p className="muted small">
          Not set up. Bank sync reads your Revolut account through Enable Banking's free personal-use Open Banking access.
          See the README ("Automatic sync"), then run <code>npm run bank -- setup</code> and <code>npm run bank -- link</code>.
        </p>
      ) : (
        <div className="row">
          <span>
            {s.accounts} account(s) linked · last sync {s.lastSync ? new Date(s.lastSync).toLocaleString() : 'never'} ·{' '}
            {s.daysLeft !== null && s.daysLeft < 0
              ? <b className="error">access expired, run <code>npm run bank -- link</code></b>
              : <span className={s.daysLeft !== null && s.daysLeft < 14 ? 'error' : 'muted'}>access valid for {s.daysLeft} more days</span>}
          </span>
          <div className="spacer" />
          <button disabled={busy} onClick={async () => {
            setBusy(true); setMsg(null);
            try { const r = await api.sync(); setMsg(`${r.added} new, ${r.updated} updated.`); await onSynced(); setS(await api.syncStatus()); }
            catch (e) { setMsg((e as Error).message); }
            finally { setBusy(false); }
          }}>{busy ? 'Syncing…' : 'Sync now'}</button>
        </div>
      )}
      {msg && <p className="small">{msg}</p>}
      <p className="muted small" style={{ marginBottom: 0 }}>While the app is running it syncs automatically every 8 hours (banks allow about 4 automatic fetches per day).</p>
    </div>
  );
}
