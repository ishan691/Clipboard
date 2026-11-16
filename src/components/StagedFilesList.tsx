import { Archive, ArrowUpRight, Check, File, X, RotateCw } from 'lucide-react';
import { QueueItem, formatSize } from '../lib/api';
import { ProgressBar } from './ProgressBar';

interface Props {
  items: QueueItem[]; busy: boolean; canSend: boolean; onRemove: (id: string) => void;
  onUpload: (asZip: boolean) => void; onCancel: () => void;
}

export function StagedFilesList({ items, busy, canSend, onRemove, onUpload, onCancel }: Props) {
  if (!items.length) return null;
  const errors = items.some(item => item.status === 'error');
  return <section className="queue" aria-label="Upload queue">
    <div className="section-label"><span>{items.length} {items.length === 1 ? 'FILE' : 'FILES'} IN QUEUE</span><span>{formatSize(items.reduce((sum, item) => sum + item.file.size, 0))}</span></div>
    <div className="queue-list">{items.map(item => <div className="queue-item" key={item.id}>
      <div className="queue-top"><span className={`file-icon ${item.status === 'done' ? 'success-icon' : ''}`}>{item.status === 'done' ? <Check size={17} /> : <File size={17} />}</span>
        <div className="file-details"><span className="filename" title={item.file.name}>{item.file.name}</span><span className={`file-meta ${item.error ? 'text-error' : ''}`}>
          {item.error || (item.status === 'uploading' ? item.progress >= 100 ? 'Finalizing…' : `${Math.round(item.progress)}% · ${formatSize(item.speed)}/s` : item.status === 'done' ? 'Transferred' : formatSize(item.file.size))}
        </span></div>
        {!busy && <button className="icon-button" aria-label={`Remove ${item.file.name}`} onClick={() => onRemove(item.id)}><X size={16} /></button>}
      </div>{item.status === 'uploading' && <ProgressBar progress={item.progress} label={`Uploading ${item.file.name}`} />}
    </div>)}</div>
    {busy ? <button className="button button-secondary full-width" onClick={onCancel}><X size={15} /> Cancel uploads</button>
      : <div className="upload-actions"><button className="button button-primary" disabled={!canSend} onClick={() => onUpload(false)}>
        {errors ? <RotateCw size={16} /> : <ArrowUpRight size={17} />}{errors ? 'Retry remaining' : `Send ${items.length === 1 ? 'file' : 'files'}`}</button>
        {items.length > 1 && <button className="button button-secondary" disabled={!canSend} onClick={() => onUpload(true)}><Archive size={15} /> Send as ZIP</button>}</div>}
  </section>;
}
