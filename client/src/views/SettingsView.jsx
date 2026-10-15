import { useState } from 'react';
import { Palette, RefreshCw, Check, Sparkles, Info, Shield, ExternalLink } from 'lucide-react';
import { useTheme } from '../context/ThemeContext.jsx';
import { api } from '../api.js';
import { toast } from '../components/layout/Toast.jsx';

export function SettingsView({ user, onScanComplete }) {
  const { theme, setTheme, themes } = useTheme();
  const [scanning, setScanning] = useState(false); // false | 'incremental' | 'full'

  const handleRescan = async ({ full = false, reextractCovers = false } = {}) => {
    if (scanning) return;
    const mode = full ? 'full' : 'incremental';
    setScanning(mode);
    try {
      const res = await api.scan({ full, reextractCovers });
      toast(
        `Scan complete: ${res.result?.processed || 0} files processed, ${res.result?.covers || 0} covers`,
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
      <section className="glass-panel p-6 sm:p-7 rounded-3xl border border-white/[0.08] space-y-5">
        <div className="flex items-center gap-2.5">
          <RefreshCw className="w-5 h-5 text-accent" />
          <div>
            <h2 className="text-base font-bold text-white">Library Synchronization</h2>
            <p className="text-xs text-surface-400">
              Manage library scanning, detect file changes, and synchronize metadata.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
          {/* Incremental Scan Card */}
          <div className="p-4 sm:p-5 rounded-2xl bg-white/[0.025] border border-white/[0.06] flex flex-col justify-between space-y-4">
            <div>
              <div className="flex items-center gap-2 text-white font-semibold text-sm">
                <RefreshCw className="w-4 h-4 text-accent" />
                <span>Incremental Rescan</span>
              </div>
              <p className="text-[11px] text-surface-400 mt-1 leading-relaxed">
                Fast scan for new or removed files and repairs moved tracks without re-reading unchanged files.
              </p>
            </div>
            <button
              onClick={() => handleRescan({ full: false })}
              disabled={!!scanning}
              className={`btn-primary px-4 py-2.5 text-xs w-full justify-center ${
                scanning ? 'opacity-60 cursor-not-allowed' : ''
              }`}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${scanning === 'incremental' ? 'animate-spin' : ''}`} />
              <span>{scanning === 'incremental' ? 'Scanning (Incremental)...' : 'Start Incremental Scan'}</span>
            </button>
          </div>

          {/* Full Rescan Card */}
          <div className="p-4 sm:p-5 rounded-2xl bg-white/[0.025] border border-white/[0.06] flex flex-col justify-between space-y-4">
            <div>
              <div className="flex items-center gap-2 text-white font-semibold text-sm">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span>Full Rescan</span>
              </div>
              <p className="text-[11px] text-surface-400 mt-1 leading-relaxed">
                Deep rebuild of the entire library: re-reads all audio tags from disk, regenerates all artwork, and cleans up orphaned metadata.
              </p>
            </div>
            <button
              onClick={() => handleRescan({ full: true, reextractCovers: true })}
              disabled={!!scanning}
              className={`px-4 py-2.5 text-xs w-full justify-center rounded-xl font-medium transition-all duration-200 flex items-center gap-2 bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 border border-amber-500/30 ${
                scanning ? 'opacity-60 cursor-not-allowed' : ''
              }`}
            >
              <Sparkles className={`w-3.5 h-3.5 ${scanning === 'full' ? 'animate-spin' : ''}`} />
              <span>{scanning === 'full' ? 'Full Rescanning...' : 'Start Full Rescan'}</span>
            </button>
          </div>
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
            <span className="text-surface-500 block text-[11px]">Author</span>
            <span className="font-semibold text-white">skippingclass</span>
          </div>
          <div className="bg-white/[0.02] p-3 rounded-xl border border-white/[0.04]">
            <span className="text-surface-500 block text-[11px]">Repository</span>
            <a
              href="https://github.com/skippingclass/TuneCloud"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-accent hover:underline inline-flex items-center gap-1.5 transition-colors"
            >
              <span>GitHub</span>
              <ExternalLink className="w-3 h-3 shrink-0" />
            </a>
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
