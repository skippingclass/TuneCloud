import { useState } from 'react';
import { Palette, RefreshCw, Check, Sparkles, Info, Shield } from 'lucide-react';
import { useTheme } from '../context/ThemeContext.jsx';
import { api } from '../api.js';
import { toast } from '../components/layout/Toast.jsx';

export function SettingsView({ user, onScanComplete }) {
  const { theme, setTheme, themes } = useTheme();
  const [scanning, setScanning] = useState(false);

  const handleRescan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const res = await api.scan();
      toast(
        `Scan complete: ${res.result?.processed || 0} files, ${res.result?.covers || 0} covers`,
        'success'
      );
      onScanComplete?.();
    } catch (err) {
      toast(`Scan failed: ${err.message}`, 'error');
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-8 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">
          Settings & Customization
        </h1>
        <p className="text-xs text-surface-400 mt-1">
          Customize your visual experience and manage your TuneCloud instance.
        </p>
      </div>

      {/* Theme selection section */}
      <section className="glass-panel p-6 sm:p-7 rounded-3xl border border-white/[0.08] space-y-5">
        <div className="flex items-center gap-2.5">
          <Palette className="w-5 h-5 text-accent" />
          <div>
            <h2 className="text-base font-bold text-white">Interface Accent Theme</h2>
            <p className="text-xs text-surface-400">
              Select your favorite accent color palette.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          {themes.map((t) => {
            const isSelected = theme === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTheme(t.id)}
                className={`p-4 rounded-2xl border text-left transition-all duration-200 flex items-center justify-between group ${
                  isSelected
                    ? 'bg-white/[0.08] border-white/[0.2] shadow-glass'
                    : 'bg-white/[0.025] hover:bg-white/[0.05] border-white/[0.06] hover:border-white/[0.12]'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-7 h-7 rounded-full shadow-md flex items-center justify-center shrink-0 border border-white/20"
                    style={{
                      background: `linear-gradient(135deg, ${t.primary} 0%, ${t.secondary} 100%)`,
                    }}
                  />
                  <div>
                    <span className="text-xs font-bold text-white block">
                      {t.name}
                    </span>
                    <span className="text-[10px] text-surface-400 font-mono">
                      {t.primary}
                    </span>
                  </div>
                </div>

                {isSelected && (
                  <div className="w-5 h-5 rounded-full bg-white text-surface-950 flex items-center justify-center shrink-0 shadow-sm">
                    <Check className="w-3.5 h-3.5 stroke-[3]" />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* Library maintenance section */}
      <section className="glass-panel p-6 sm:p-7 rounded-3xl border border-white/[0.08] space-y-4">
        <div className="flex items-center gap-2.5">
          <RefreshCw className="w-5 h-5 text-accent" />
          <div>
            <h2 className="text-base font-bold text-white">Library Synchronization</h2>
            <p className="text-xs text-surface-400">
              Detect new music files, updated metadata, and artwork.
            </p>
          </div>
        </div>

        <div className="pt-2">
          <button
            onClick={handleRescan}
            disabled={scanning}
            className={`btn-primary px-5 py-2.5 text-xs ${
              scanning ? 'opacity-60 cursor-not-allowed' : ''
            }`}
          >
            <RefreshCw className={`w-4 h-4 ${scanning ? 'animate-spin' : ''}`} />
            <span>{scanning ? 'Scanning Filesystem...' : 'Start Full Library Rescan'}</span>
          </button>
        </div>
      </section>

      {/* Instance info */}
      <section className="glass-panel p-6 rounded-3xl border border-white/[0.08] space-y-3">
        <div className="flex items-center gap-2.5">
          <Info className="w-4 h-4 text-surface-400" />
          <h3 className="text-xs font-bold text-surface-300 uppercase tracking-wider">
            System & Protocol
          </h3>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
          <div className="bg-white/[0.02] p-3 rounded-xl border border-white/[0.04]">
            <span className="text-surface-500 block text-[11px]">Server</span>
            <span className="font-semibold text-white">TuneCloud 0.1.0</span>
          </div>
          <div className="bg-white/[0.02] p-3 rounded-xl border border-white/[0.04]">
            <span className="text-surface-500 block text-[11px]">Subsonic API</span>
            <span className="font-semibold text-white">1.16.1</span>
          </div>
          <div className="bg-white/[0.02] p-3 rounded-xl border border-white/[0.04]">
            <span className="text-surface-500 block text-[11px]">Synced Lyrics</span>
            <span className="font-semibold text-white">LRCLIB & Local .lrc</span>
          </div>
        </div>
      </section>
    </div>
  );
}
