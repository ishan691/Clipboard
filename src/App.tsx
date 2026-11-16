import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Clock3, FileText, Files, RefreshCw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Header } from './components/Header';
import { DragDropZone } from './components/DragDropZone';
import { StagedFilesList } from './components/StagedFilesList';
import { QuickTextBox } from './components/QuickTextBox';
import { RecentTransfersTable } from './components/RecentTransfersTable';
import { API_BASE, QueueItem, Settings, TransferRecord, formatSize, request, upload } from './lib/api';

const defaults: Settings = { maxFileSizeBytes: 10 * 1024 ** 3, maxBatchFiles: 50, maxTextBytes: 1024 ** 2, expirationHours: 24 };

export default function App() {
  const [tab, setTab] = useState<'files' | 'text'>(() => window.location.hash === '#text' ? 'text' : 'files');
  const changeTab = (next: 'files' | 'text') => {
    setTab(next);
    window.history.replaceState(null, '', `#${next}`);
  };
  useEffect(() => {
    const syncTab = () => setTab(window.location.hash === '#text' ? 'text' : 'files');
    window.addEventListener('hashchange', syncTab);
    return () => window.removeEventListener('hashchange', syncTab);
  }, []);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [keepForever, setKeepForever] = useState(false);
  const [settings, setSettings] = useState(defaults);
  const [transfers, setTransfers] = useState<TransferRecord[]>([]);
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [refreshing, setRefreshing] = useState(true);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const active = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  const loading = useRef(false);
  const revision = useRef(0);

  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    const startedAtRevision = revision.current;
    setRefreshing(true);
    try {
      const signal = AbortSignal.timeout(10000);
      const [records, configuration] = await Promise.all([
        request<TransferRecord[]>(API_BASE, { signal }), request<Settings>(`${API_BASE}/settings`, { signal }),
      ]);
      if (mounted.current) {
        if (startedAtRevision === revision.current) setTransfers(records);
        setSettings(configuration); setStatus('online'); setLastSynced(new Date());
      }
    } catch { if (mounted.current) setStatus('offline'); }
    finally { loading.current = false; if (mounted.current) setRefreshing(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onVisible = () => { if (!document.hidden) void refresh(); };
    const interval = window.setInterval(onVisible, 15000);
    document.addEventListener('visibilitychange', onVisible);
    return () => { mounted.current = false; window.clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); active.current?.abort(); };
  }, [refresh]);

  const addFiles = (files: File[]) => {
    if (locked.current) return;
    const valid = files.filter(file => {
      if (!file.size) { toast.error(`${file.name} is empty`); return false; }
      if (file.size > settings.maxFileSizeBytes) { toast.error(`${file.name} exceeds ${formatSize(settings.maxFileSizeBytes)}`); return false; }
      if (file.name.length > 180 || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(file.name)) { toast.error(`${file.name}: rename this file before uploading`); return false; }
      return true;
    });
    setQueue(previous => {
      const available = settings.maxBatchFiles - previous.length;
      if (valid.length > available) toast.error(`Queue up to ${settings.maxBatchFiles} files at a time`);
      return [...previous, ...valid.slice(0, Math.max(0, available)).map(file => ({ id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, file, status: 'queued' as const, progress: 0, speed: 0 }))];
    });
  };

  const sendFiles = async (asZip: boolean) => {
    if (locked.current || !queue.length) return;
    if (asZip && queue.reduce((sum, item) => sum + item.file.size, 0) > settings.maxFileSizeBytes) {
      toast.error(`A ZIP transfer can contain up to ${formatSize(settings.maxFileSizeBytes)} in total`); return;
    }
    locked.current = true;
    setBusy(true);
    const batch = [...queue];
    const controller = new AbortController();
    active.current = controller;
    setQueue(previous => previous.map(item => ({ ...item, status: 'queued', error: undefined, progress: 0, speed: 0 })));
    let completed = 0;
    const done = new Set<string>();
    const update = (ids: string[], patch: Partial<QueueItem>) => setQueue(previous => previous.map(item => ids.includes(item.id) ? { ...item, ...patch } : item));
    const remember = (record: TransferRecord) => {
      revision.current++;
      setTransfers(previous => [record, ...previous.filter(item => item.id !== record.id)].slice(0, 200));
    };
    try {
      if (asZip) {
        const ids = batch.map(item => item.id);
        update(ids, { status: 'uploading' });
        const form = new FormData();
        batch.forEach(item => form.append('files', item.file));
        try {
          const record = await upload(`${API_BASE}/batch?keepForever=${keepForever}`, form, controller.signal,
            (progress, speed) => update(ids, { progress, speed: speed / batch.length }));
          remember(record); ids.forEach(id => done.add(id)); completed = batch.length;
          update(ids, { status: 'done', progress: 100 });
        } catch (error) { update(ids, { status: 'error', error: (error as Error).message }); }
      } else {
        let cursor = 0;
        const worker = async () => {
          while (cursor < batch.length && !controller.signal.aborted) {
            const item = batch[cursor++];
            update([item.id], { status: 'uploading' });
            try {
              const query = new URLSearchParams({ filename: item.file.name, keepForever: String(keepForever) });
              const record = await upload(`${API_BASE}/raw?${query}`, item.file, controller.signal,
                (progress, speed) => update([item.id], { progress, speed }));
              remember(record); completed++; done.add(item.id);
              update([item.id], { status: 'done', progress: 100 });
            } catch (error) { update([item.id], { status: 'error', error: (error as Error).message }); }
          }
        };
        // Bounded parallelism keeps small files moving without opening an unbounded number of connections.
        await Promise.all(Array.from({ length: Math.min(2, batch.length) }, worker));
      }
      if (completed) toast.success(asZip ? 'ZIP ready to share' : `${completed} ${completed === 1 ? 'file' : 'files'} transferred`);
      if (completed < batch.length && !controller.signal.aborted) toast.error('Some files need another try. They are still in your queue.');
    } finally {
      setQueue(previous => previous.filter(item => !done.has(item.id)).map(item => controller.signal.aborted
        ? { ...item, status: 'error', error: 'Canceled. Ready to retry.' } : item));
      active.current = null; locked.current = false; setBusy(false); void refresh();
    }
  };

  const sendText = async (title: string, text: string): Promise<boolean> => {
    if (locked.current) return false;
    locked.current = true; setBusy(true);
    try {
      const record = await request<TransferRecord>(`${API_BASE}/text`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, text, keepForever }), signal: AbortSignal.timeout(30000) });
      revision.current++;
      setTransfers(previous => [record, ...previous.filter(item => item.id !== record.id)].slice(0, 200));
      toast.success('Text ready to share'); void refresh(); return true;
    } catch (error) { toast.error((error as Error).message); return false; }
    finally { locked.current = false; setBusy(false); }
  };

  const deleteTransfer = async (id: string) => {
    try { await request<void>(`${API_BASE}/${id}`, { method: 'DELETE' }); revision.current++; setTransfers(previous => previous.filter(item => item.id !== id)); toast.success('Transfer deleted'); }
    catch (error) { toast.error((error as Error).message); }
  };
  const visible = transfers.filter(item => new Date(item.expiresAt).getTime() > Date.now());

  const fileTransfers = visible.filter(item => item.type !== 'text');
  const textTransfers = visible.filter(item => item.type === 'text');
  const currentTransfers = tab === 'files' ? fileTransfers : textTransfers;

  return <><Header status={status} /><main className="shell workspace">
    <section className="intro">
      <div><h1>Transfer workspace</h1><p className="intro-copy">A shared place for files and text. Ready on your next device.</p></div>
      <div className="workspace-label"><ShieldCheck size={16} /> Shared workspace</div>
    </section>
    {status === 'offline' && <div className="connection-banner" role="alert">We couldn’t reach your workspace. Your queued files and drafts are safe.<button onClick={() => void refresh()}>Reconnect <RefreshCw size={16} /></button></div>}
    <section className="workspace-summary" aria-label="Workspace overview">
      <div><span>Active file transfers</span><strong>{fileTransfers.length}<span>files & archives</span></strong></div>
      <div><span>Text snippets</span><strong>{textTransfers.length}<span>ready to share</span></strong></div>
      <div><span>Workspace size</span><strong>{formatSize(visible.reduce((sum, item) => sum + item.size, 0))}<span>across active transfers</span></strong></div>
    </section>
    <div className="tabs" role="tablist" aria-label="Transfer content" onKeyDown={event => {
      if (busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'files' : event.key === 'End' ? 'text' : tab === 'files' ? 'text' : 'files';
      changeTab(next);
      document.getElementById(`${next}-tab`)?.focus();
    }}>
      <button id="files-tab" role="tab" aria-selected={tab === 'files'} aria-controls="files-panel" tabIndex={tab === 'files' ? 0 : -1} disabled={busy} onClick={() => changeTab('files')}><Files size={18} /> Files<span className="tab-count">{fileTransfers.length}</span></button>
      <button id="text-tab" role="tab" aria-selected={tab === 'text'} aria-controls="text-panel" tabIndex={tab === 'text' ? 0 : -1} disabled={busy} onClick={() => changeTab('text')}><FileText size={18} /> Text<span className="tab-count">{textTransfers.length}</span></button>
      <span className="tabs-caption">One workspace, fewer round trips</span>
    </div>
    <div className={`workspace-grid ${tab === 'text' ? 'text-workspace' : ''}`}>
      <section className="panel composer" aria-label={tab === 'files' ? 'Send files' : 'Send text'}>
        <div className="panel-heading"><div><h2>{tab === 'files' ? 'Send files' : 'Send text'}</h2><p>{tab === 'files' ? 'Move something to your next device' : 'Keep a note, link, or code within reach'}</p></div><span className="heading-symbol">{tab === 'files' ? <ArrowUpRight size={20} /> : <FileText size={20} />}</span></div>
        <div id="files-panel" role="tabpanel" aria-labelledby="files-tab" hidden={tab !== 'files'}>
          <DragDropZone onFilesSelected={addFiles} disabled={busy} maxSize={settings.maxFileSizeBytes} />
          <StagedFilesList items={queue} busy={busy} canSend={status === 'online'} onRemove={id => setQueue(previous => previous.filter(item => item.id !== id))}
            onUpload={zip => void sendFiles(zip)} onCancel={() => active.current?.abort()} />
        </div>
        <div id="text-panel" role="tabpanel" aria-labelledby="text-tab" hidden={tab !== 'text'}><QuickTextBox onSendText={sendText} busy={busy} canSend={status === 'online'} maxBytes={settings.maxTextBytes} /></div>
        <div className="retention-setting"><Clock3 size={16} /><label htmlFor="retention">Available for</label><select id="retention" disabled={busy} value={keepForever ? 'forever' : 'default'} onChange={event => setKeepForever(event.target.value === 'forever')}>
          <option value="default">{settings.expirationHours} hours</option><option value="forever">Until deleted</option></select></div>
      </section>
      <section className="panel history" aria-labelledby="history-title">
        <div className="panel-heading"><div><h2 id="history-title">{tab === 'files' ? 'Recent files' : 'Recent text'}<span className="count-badge">{currentTransfers.length}</span></h2><p>Download, copy a link, or clear a transfer</p></div>
          <button className="icon-button" aria-label="Refresh transfers" disabled={refreshing} onClick={() => void refresh()}><RefreshCw className={refreshing ? 'spin' : ''} size={18} /></button></div>
        <RecentTransfersTable key={tab} transfers={currentTransfers} loading={refreshing} onDelete={deleteTransfer} />
        <div className="history-footer"><span>{lastSynced ? `Last synced ${lastSynced.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Waiting for connection'}</span><span>Latest 200 transfers</span></div>
      </section>
    </div>
    <footer className="workspace-footer"><span><ShieldCheck size={16} />Shared workspace · Visible to anyone who can reach this app.</span><span>Files and text, within reach</span></footer>
  </main></>;
}
