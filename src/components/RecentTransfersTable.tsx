import { useEffect, useRef, useState } from 'react';
import { Archive, ArrowDown, Check, File, FileText, Link, Search, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { API_BASE, TransferRecord, formatSize } from '../lib/api';

interface Props { transfers: TransferRecord[]; loading: boolean; onDelete: (id: string) => Promise<void>; }
function expiry(value: string) {
  const date = new Date(value);
  if (date.getFullYear() > 9000) return 'Until deleted';
  const minutes = Math.ceil((date.getTime() - Date.now()) / 60000);
  return minutes <= 0 ? 'Expired' : minutes < 60 ? `${minutes}m left` : `${Math.ceil(minutes / 60)}h left`;
}

export function RecentTransfersTable({ transfers, loading, onDelete }: Props) {
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [share, setShare] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const filtered = transfers.filter(t => t.filename.toLowerCase().includes(search.toLowerCase()) && (type === 'all' || t.type === type));
  useEffect(() => { if (share) { dialog.current?.showModal(); linkInput.current?.select(); } }, [share]);
  const copy = async (id: string) => {
    const url = new URL(`${API_BASE}/download/${id}`, window.location.origin).href;
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch { setShare(url); }
  };
  const remove = async (id: string) => {
    setDeleting(id);
    try { await onDelete(id); setConfirm(null); } finally { setDeleting(null); }
  };
  return <>
    <div className="history-tools"><div className="search-field"><Search size={16} /><input aria-label="Search transfers" placeholder="Search transfers" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <select aria-label="Filter transfer type" value={type} onChange={e => setType(e.target.value)}><option value="all">All types</option><option value="file">Files</option><option value="zip">Archives</option></select></div>
    <div className="transfer-list" data-testid="recent-transfers-list" aria-busy={loading}>
      {loading && !transfers.length ? <div className="skeleton-list" aria-label="Loading transfers">{[1, 2, 3].map(i => <div className="skeleton" key={i} />)}</div>
        : !filtered.length ? <div className="empty-state"><div className="empty-icon"><Archive size={28} strokeWidth={1.25} /></div><h3>{transfers.length ? 'No matches found' : 'No transfers yet'}</h3><p>{transfers.length ? 'Try another name or file type.' : 'Send a file or text to make it available here.'}</p></div>
          : filtered.map(transfer => <article className="transfer-row" key={transfer.id}>
            <span className={`file-icon type-${transfer.type}`}>{transfer.type === 'text' ? <FileText size={20} /> : transfer.type === 'zip' ? <Archive size={20} /> : <File size={20} />}</span>
            <div className="file-details"><h3 className="filename" title={transfer.filename}>{transfer.filename}</h3><p className="file-meta">{formatSize(transfer.size)}<span className="meta-divider" aria-hidden="true" />{expiry(transfer.expiresAt)}</p></div>
            <div className="row-actions">{confirm === transfer.id ? <><button className="delete-confirm" disabled={deleting === transfer.id} onClick={() => void remove(transfer.id)}>Delete?</button><button className="icon-button" aria-label="Cancel deletion" onClick={() => setConfirm(null)}><X size={16} /></button></>
              : <><button className="icon-button" aria-label={`Copy link for ${transfer.filename}`} title="Copy link" onClick={() => void copy(transfer.id)}><Link size={16} /></button>
                <a className="icon-button download-action" href={`${API_BASE}/download/${transfer.id}`} download aria-label={`Download ${transfer.filename}`} title="Download"><ArrowDown size={17} /></a>
                <button className="icon-button delete-action" aria-label={`Delete ${transfer.filename}`} title="Delete" onClick={() => setConfirm(transfer.id)}><Trash2 size={15} /></button></>}
            </div></article>)}
    </div>
    <dialog ref={dialog} className="share-dialog" onClose={() => setShare('')}>
      <div className="dialog-heading"><h3>Share this transfer</h3><button className="icon-button" aria-label="Close share link" onClick={() => dialog.current?.close()}><X size={18} /></button></div>
      <p>Select and copy the link below. It works while the transfer is active.</p>
      <input ref={linkInput} aria-label="Transfer share link" readOnly value={share} onFocus={e => e.target.select()} />
      <button className="button button-primary full-width" onClick={() => dialog.current?.close()}><Check size={16} /> Done</button>
    </dialog>
  </>;
}
