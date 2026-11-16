import { useState } from 'react';
import { ArrowUpRight, Loader2 } from 'lucide-react';
import { formatSize } from '../lib/api';

interface Props { onSendText: (title: string, text: string) => Promise<boolean>; busy: boolean; canSend: boolean; maxBytes: number; }
export function QuickTextBox({ onSendText, busy, canSend, maxBytes }: Props) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const bytes = new TextEncoder().encode(text).length;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await onSendText(title, text)) { setTitle(''); setText(''); }
  };
  return <form className="text-form" onSubmit={submit}>
    <label htmlFor="snippet-title">Title <span className="optional">optional</span></label>
    <input id="snippet-title" value={title} maxLength={180} onChange={e => setTitle(e.target.value)} placeholder="A name for your note" disabled={busy} />
    <label htmlFor="snippet-text">Your text</label>
    <textarea id="snippet-text" value={text} onChange={e => setText(e.target.value)} placeholder="A thought, a link, a little bit of code…" disabled={busy} />
    <div className={`text-count ${bytes > maxBytes ? 'text-error' : ''}`}>{formatSize(bytes)} / {formatSize(maxBytes)}</div>
    <button className="button button-primary full-width" disabled={busy || !canSend || !text.trim() || bytes > maxBytes} type="submit">
      {busy ? <Loader2 size={16} className="spin" /> : <ArrowUpRight size={17} />} Send text</button>
  </form>;
}
