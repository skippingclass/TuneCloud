import { useState } from 'react';
import {
  Home,
  Disc,
  Users,
  Music2,
  Heart,
  Folder,
  Search,
  Settings,
  RefreshCw,
  LogOut,
  Shield,
  X,
} from 'lucide-react';
import { api } from '../../api.js';
import { toast } from './Toast.jsx';

export function Sidebar({
  activeView,
  onViewChange,
  user,
  onLogout,
  onScanComplete,
  open,
  onClose,
}) {
  const [scanning, setScanning] = useState(false);

  const mainLinks = [
    { id: 'home', label: 'Home', icon: Home },
    { id: 'albums', label: 'Albums', icon: Disc },
    { id: 'artists', label: 'Artists', icon: Users },
    { id: 'tracks', label: 'Tracks', icon: Music2 },
    { id: 'favorites', label: 'Favorites', icon: Heart },
    { id: 'browse', label: 'Folders', icon: Folder },
    { id: 'search', label: 'Search', icon: Search },
  ];

  const handleNav = (id) => {
    onViewChange(id);
    onClose?.();
  };

  const handleRescan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const res = await api.scan({ full: false });
      toast(`Scan complete: ${res.result?.processed || 0} processed, ${res.result?.covers || 0} covers`, 'success');
      onScanComplete?.();
    } catch (err) {
      toast(`Scan failed: ${err.message}`, 'error');
    } finally {
      setScanning(false);
    }
  };

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-40 lg:hidden transition-opacity"
          onClick={onClose}
        />
      )}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-50 w-64 glass-panel border-r border-white/[0.06] flex flex-col h-full select-none transition-transform duration-300 ease-out lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Brand header */}
        <div className="p-5 flex items-center justify-between border-b border-white/[0.06]">
          <button
            onClick={() => handleNav('home')}
            className="text-left group"
          >
            <span className="text-lg font-bold tracking-tight text-white group-hover:text-accent transition-colors">
              TuneCloud
            </span>
          </button>
          <button
            onClick={onClose}
            className="lg:hidden p-1.5 rounded-lg text-surface-400 hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation links */}
        <div className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          <p className="px-3 pb-2 text-[11px] font-semibold tracking-wider text-surface-500 uppercase">
            Library
          </p>
          {mainLinks.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleNav(item.id)}
                className={`w-full flex items-center gap-3.5 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 group ${
                  isActive
                    ? 'bg-gradient-to-r from-accent/20 to-accent-hover/10 text-accent border border-accent/25 shadow-glow'
                    : 'text-surface-400 hover:text-surface-100 hover:bg-white/[0.04]'
                }`}
              >
                <Icon
                  className={`w-4 h-4 transition-transform duration-200 group-hover:scale-110 ${
                    isActive ? 'text-accent stroke-[2.5]' : 'text-surface-400'
                  }`}
                />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* Bottom utility controls */}
        <div className="p-3.5 border-t border-white/[0.06] space-y-2.5 bg-black/20">
          <button
            disabled={scanning}
            onClick={handleRescan}
            className={`w-full btn-glass text-xs justify-between py-2 px-3 ${
              scanning ? 'opacity-60 cursor-not-allowed' : ''
            }`}
          >
            <span className="flex items-center gap-2">
              <RefreshCw
                className={`w-3.5 h-3.5 text-accent ${
                  scanning ? 'animate-spin' : ''
                }`}
              />
              <span>{scanning ? 'Scanning...' : 'Rescan Library'}</span>
            </span>
          </button>

          <button
            onClick={() => handleNav('settings')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
              activeView === 'settings'
                ? 'bg-white/[0.08] text-white border border-white/[0.1]'
                : 'text-surface-400 hover:text-white hover:bg-white/[0.04]'
            }`}
          >
            <Settings className="w-4 h-4 text-surface-400" />
            <span>Settings & Themes</span>
          </button>

          {user?.is_admin && (
            <button
              onClick={() => handleNav('admin')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
                activeView === 'admin'
                  ? 'bg-accent/15 text-accent border border-accent/25'
                  : 'text-surface-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <Shield className="w-4 h-4 text-accent" />
              <span>Admin Panel</span>
            </button>
          )}

          {/* User badge */}
          <div className="pt-2 border-t border-white/[0.05] flex items-center justify-between px-1.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-7 h-7 rounded-full bg-accent/20 border border-accent/30 text-accent font-semibold text-xs flex items-center justify-center shrink-0">
                {(user?.username || 'U')[0].toUpperCase()}
              </div>
              <span className="text-xs font-medium text-surface-300 truncate max-w-[90px]">
                {user?.username}
              </span>
            </div>
            <button
              onClick={onLogout}
              className="p-1.5 text-surface-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors"
              title="Logout"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
