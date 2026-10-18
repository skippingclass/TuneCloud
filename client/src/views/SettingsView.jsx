import { useState, useEffect } from 'react';
import { Palette, RefreshCw, Check, Sparkles, Info, Shield, ExternalLink, Loader2 } from 'lucide-react';
import { useTheme } from '../context/ThemeContext.jsx';
import { api } from '../api.js';
import { toast } from '../components/layout/Toast.jsx';

export function SettingsView({ user, onScanComplete }) {
  const { theme, setTheme, themes } = useTheme();
  const [scanning, setScanning] = useState(false); // false | 'incremental' | 'full'
  const [progress, setProgress] = useState(null);

  // Auto-detect ongoing scan on mount
  useEffect(() => {
    let timer = null;
    let mounted = true;

    const checkStatus = async () => {
      try {
        const data = await api.scanStatus();
        if (!mounted) return;
        if (data.isScanning) {
          setScanning(data.progress?.full ? 'full' : 'incremental');
          setProgress(data.progress);
          timer = setTimeout(checkStatus, 1200);
        } else {
          setScanning(false);
          setProgress(null);
        }
      } catch {}
    };

    checkStatus();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const handleRescan = async ({ full = false, reextractCovers = false } = {}) => {
    if (scanning) return;
    const mode = full ? 'full' : 'incremental';
    setScanning(mode);
    setProgress({ phase: 'starting', total: 0, processed: 0 });

    try {
      await api.scan({ full, reextractCovers });

      // Poll until background scan completes
      let active = true;
      const poll = async () => {
        if (!active) return;
        try {
          const st = await api.scanStatus();
          if (st.isScanning) {
            setProgress(st.progress);
            setTimeout(poll, 1200);
          } else {
            setScanning(false);
            setProgress(null);
            if (st.progress?.phase === 'error') {
              toast(`Scan failed: ${st.progress.error}`, 'error');
            } else {
              const r = st.lastResult || {};
              toast(
                `Scan complete: ${r.processed || 0} tracks, ${r.covers || 0} covers in ${r.durationSeconds || 0}s`,
                'success'
              );
              onScanComplete?.();
            }
          }
        } catch {
          setTimeout(poll, 2000);
        }
      };

      setTimeout(poll, 800);
    } catch (err) {
      toast(`Could not start scan: ${err.message}`, 'error');
      setScanning(false);
      setProgress(null);
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

        {/* Live scanning progress banner */}
        {scanning && (
          <div className="p-4 sm:p-5 rounded-2xl bg-accent/10 border border-accent/30 space-y-3 animate-fade-in">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Loader2 className="w-4 h-4 animate-spin text-accent" />
                <span className="text-xs font-bold text-white uppercase tracking-wider">
                  {scanning === 'full' ? 'Full Library Rescan in Progress' : 'Incremental Rescan in Progress'}
                </span>
              </div>
              {progress?.phase && (
                <span className="text-[11px] font-mono text-accent uppercase px-2 py-0.5 rounded-md bg-accent/15 border border-accent/20">
                  {progress.phase}
                </span>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-surface-300">
                <span>
                  {progress?.phase === 'listing' && 'Discovering audio files on disk...'}
                  {progress?.phase === 'processing' &&
                    `Parsing tags: ${progress.processed || 0} / ${progress.toProcess || progress.total || 0} files`}
                  {progress?.phase === 'cleaning' && 'Pruning deleted files & updating orphan records...'}
                  {progress?.phase === 'covers' &&
                    `Extracting album art: ${progress.coversExtracted || 0} / ${progress.coversTotal || 0} covers`}
                  {(!progress?.phase || progress?.phase === 'starting') && 'Initializing scanner...'}
                </span>
                {progress?.phase === 'processing' && (progress.toProcess || progress.total) > 0 && (
                  <span className="font-mono text-[11px] text-surface-400">
                    {Math.round(((progress.processed || 0) / (progress.toProcess || progress.total)) * 100)}%
                  </span>
                )}
                {progress?.phase === 'covers' && progress.coversTotal > 0 && (
                  <span className="font-mono text-[11px] text-surface-400">
                    {Math.round(((progress.coversExtracted || 0) / progress.coversTotal) * 100)}%
                  </span>
                )}
              </div>

              <div className="w-full h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-accent to-accent-hover transition-all duration-300 rounded-full"
                  style={{
                    width:
                      progress?.phase === 'processing' && (progress.toProcess || progress.total) > 0
                        ? `${Math.min(100, Math.round(((progress.processed || 0) / (progress.toProcess || progress.total)) * 100))}%`
                        : progress?.phase === 'covers' && progress.coversTotal > 0
                        ? `${Math.min(100, Math.round(((progress.coversExtracted || 0) / progress.coversTotal) * 100))}%`
                        : '100%',
                  }}
                />
              </div>
            </div>
          </div>
        )}

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
