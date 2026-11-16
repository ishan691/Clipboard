import { ArrowUpRight, Wifi, WifiOff } from 'lucide-react';

export function Header({ status }: { status: 'connecting' | 'online' | 'offline' }) {
  return <header className="site-header"><div className="shell header-inner">
    <a className="brand" href="/" aria-label="LiquidVault home"><span className="brand-mark"><ArrowUpRight size={22} /></span><span>LiquidVault</span></a>
    <span className="header-divider" /><span className="header-context">Transfer dashboard</span>
    <div className={`connection ${status}`} role="status">{status === 'offline' ? <WifiOff size={16} /> : <Wifi size={16} />}
      {status === 'online' ? 'Workspace online' : status === 'offline' ? 'Connection lost' : 'Connecting…'}</div>
  </div></header>;
}
