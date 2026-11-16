import { ArrowUpRight, Circle } from 'lucide-react';

export function Header({ status }: { status: 'connecting' | 'online' | 'offline' }) {
  return <header className="site-header"><div className="shell header-inner">
    <a className="brand" href="/" aria-label="LiquidVault home"><span className="brand-mark"><ArrowUpRight size={23} strokeWidth={2} /></span>
      <span>LiquidVault<span className="brand-dot">.</span></span></a>
    <div className={`connection ${status}`} role="status"><Circle size={7} fill="currentColor" />
      {status === 'online' ? 'Workspace online' : status === 'offline' ? 'Connection lost' : 'Connecting…'}</div>
  </div></header>;
}
