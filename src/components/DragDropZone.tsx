import { useRef, useState } from 'react';
import { ArrowUpFromLine, Plus } from 'lucide-react';
import { formatSize } from '../lib/api';

interface Props { onFilesSelected: (files: File[]) => void; disabled: boolean; maxSize: number; }

export function DragDropZone({ onFilesSelected, disabled, maxSize }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [hovered, setHovered] = useState(false);
  return <div className={`drop-zone ${hovered ? 'is-hovered' : ''} ${disabled ? 'is-disabled' : ''}`}
    data-testid="drag-drop-zone" onDragOver={e => e.preventDefault()}
    onDragEnter={e => { e.preventDefault(); depth.current++; if (!disabled) setHovered(true); }}
    onDragLeave={e => { e.preventDefault(); if (--depth.current <= 0) { depth.current = 0; setHovered(false); } }}
    onDrop={e => { e.preventDefault(); depth.current = 0; setHovered(false); if (!disabled) onFilesSelected(Array.from(e.dataTransfer.files)); }}>
    <div className="drop-icon"><ArrowUpFromLine size={28} strokeWidth={1.6} /></div>
    <h3>Drop your files here</h3><p>Documents, images, and everything in between</p>
    <button className="button button-primary" disabled={disabled} onClick={() => input.current?.click()}><Plus size={15} /> Choose files</button>
    <input ref={input} type="file" multiple disabled={disabled} className="sr-only" aria-label="Choose files to upload"
      onChange={e => { onFilesSelected(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
    <span className="drop-hint">Up to {formatSize(maxSize)} per file</span>
  </div>;
}
