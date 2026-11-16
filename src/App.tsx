import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Clock3, FileText, Files, HardDrive, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Header } from './components/Header';
import { DragDropZone } from './components/DragDropZone';
import { StagedFilesList } from './components/StagedFilesList';
import { QuickTextBox } from './components/QuickTextBox';
import { RecentTransfersTable } from './components/RecentTransfersTable';
import { API_BASE, QueueItem, Settings, TransferRecord, formatSize, request, upload } from './lib/api';

const defaults: Settings = { maxFileSizeBytes: 10 * 1024 ** 3, maxBatchFiles: 50, maxTextBytes: 1024 ** 2, expirationHours: 24 };

export default function App() {
  const [tab, setTab] = useState<'files' | 'text'>('files');
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

  return <><Header status={status} /><main className="shell workspace">
    <section className="intro"><div><p className="eyebrow"><span /> LESS FRICTION. MORE FLOW.</p><h1>Your files.<br className="mobile-break" /> Within reach<span>.</span></h1>
      <p className="intro-copy">From one device to the next. Share files and notes<br className="desktop-break" /> in a workspace that stays out of your way.</p></div>
      <div className="workspace-summary"><div><Files size={17} /><strong>{visible.length}</strong><span>active transfers</span></div>
        <div><HardDrive size={17} /><strong>{formatSize(visible.reduce((sum, item) => sum + item.size, 0))}</strong><span>in your workspace</span></div></div>
    </section>
    {status === 'offline' && <div className="connection-banner" role="alert">We couldn’t reach your workspace. Your queued files and drafts are safe.<button onClick={() => void refresh()}>Reconnect <RefreshCw size={13} /></button></div>}
    <div className="workspace-grid"><section className="panel composer"><div className="panel-heading"><span className="section-label">01 / SEND SOMETHING</span><ArrowUpRight size={19} /></div>
      <div className="tabs" role="tablist" aria-label="Transfer content"><button id="files-tab" role="tab" aria-selected={tab === 'files'} aria-controls="files-panel" disabled={busy} onClick={() => setTab('files')}><Files size={16} /> Files</button>
        <button id="text-tab" role="tab" aria-selected={tab === 'text'} aria-controls="text-panel" disabled={busy} onClick={() => setTab('text')}><FileText size={16} /> Text</button></div>
      <div id="files-panel" role="tabpanel" aria-labelledby="files-tab" hidden={tab !== 'files'}>
        <DragDropZone onFilesSelected={addFiles} disabled={busy} maxSize={settings.maxFileSizeBytes} />
        <StagedFilesList items={queue} busy={busy} canSend={status === 'online'} onRemove={id => setQueue(previous => previous.filter(item => item.id !== id))}
          onUpload={zip => void sendFiles(zip)} onCancel={() => active.current?.abort()} />
      </div>
      <div id="text-panel" role="tabpanel" aria-labelledby="text-tab" hidden={tab !== 'text'}><QuickTextBox onSendText={sendText} busy={busy} canSend={status === 'online'} maxBytes={settings.maxTextBytes} /></div>
      <div className="retention-setting"><Clock3 size={15} /><label htmlFor="retention">Available for</label><select id="retention" disabled={busy} value={keepForever ? 'forever' : 'default'} onChange={event => setKeepForever(event.target.value === 'forever')}>
        <option value="default">{settings.expirationHours} hours</option><option value="forever">Until deleted</option></select></div>
    </section>
    <section className="panel history"><div className="panel-heading"><div><span className="section-label">02 / YOUR WORKSPACE</span><h2>Ready when you are<span className="count-badge">{visible.length}</span></h2></div>
      <button className={`icon-button ${refreshing ? 'spin' : ''}`} aria-label="Refresh transfers" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={17} /></button></div>
      <RecentTransfersTable transfers={visible} loading={refreshing} onDelete={deleteTransfer} />
      <div className="history-footer"><span className="sync-dot" />{lastSynced ? `Synced at ${lastSynced.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Waiting for connection'}<span className="history-limit">Latest 200 transfers</span></div>
    </section></div>
    <footer className="workspace-footer"><span>One network. A little less back and forth.</span><span>Shared workspace · Visible to anyone who can reach this app.</span></footer>
  </main></>;
}
