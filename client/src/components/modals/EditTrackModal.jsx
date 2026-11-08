import { useDialog } from '../../hooks/useDialog.js';
import { useState, useId, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Save, Edit3 } from 'lucide-react';
import { api } from '../../api.js';
import { toast } from '../layout/Toast.jsx';

export function EditTrackModal({ track, onClose, onSaved }) {
  const formId = useId();
  const dialogRef = useDialog(true, onClose);
  const [form, setForm] = useState({
    title: track.title || '',
    artist: track.artist || '',
    album: track.album || '',
    trackNumber: track.track_number || '',
    genre: track.genre || '',
    year: track.year || '',
    albumArtist: '', composer: '', discNumber: '', discTotal: '', compilation: false,
  });
  const baseline = useRef(form);
  const [capability, setCapability] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    let active = true;
    Promise.all([api.tagCapabilities(), api.tags(track.id)]).then(([cap, tags]) => {
      if (!active) return;
      const initial = { title: tags.title || '', artist: tags.artist || '', album: tags.album || '',
        trackNumber: tags.track || '', year: tags.year || '', genre: (tags.genres || [tags.genre]).filter(Boolean).join('; '),
        albumArtist: tags.albumArtist || '', composer: tags.composer || '', discNumber: tags.discNumber || '',
        discTotal: tags.discTotal || '', compilation: Boolean(tags.compilation) };
      baseline.current = initial; setForm(initial);
      const format = (track.format || track.file_name?.split('.').pop() || '').toLowerCase();
      setCapability(cap.enabled && !cap.formats.includes(format) ? { enabled: false, reason: `Editing ${format.toUpperCase()} tags is not supported.` } : cap);
    }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [track.id]);

  const handleSave = async (e) => {
    e.preventDefault();
    if (loading || !capability?.enabled) return;
    setSaving(true);
    setError('');
    try {
      const payload = {};
      for (const field of ['title', 'artist', 'album', 'albumArtist', 'composer', 'compilation']) {
        if (form[field] !== baseline.current[field]) payload[field] = form[field];
      }
      for (const field of ['trackNumber', 'year', 'discNumber', 'discTotal']) {
        if (String(form[field]) !== String(baseline.current[field])) payload[field] = form[field] === '' ? null : Number(form[field]);
      }
      if (form.genre !== baseline.current.genre) payload.genres = form.genre.split(';').map(g => g.trim()).filter(Boolean);
      await api.updateTags(track.id, payload);
      toast('Tags updated successfully', 'success');
      onSaved?.();
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Edit track tags" tabIndex={-1}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-fade-in"
      onClick={onClose}
    >
      <div
        className="glass-panel w-full max-w-md max-h-[90vh] overflow-y-auto rounded-3xl p-6 sm:p-7 shadow-glass-lg border border-white/[0.1] relative select-none animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-4 border-b border-white/[0.08] mb-5">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <Edit3 className="w-4 h-4 text-accent" />
            <span>Edit Tags</span>
          </h3>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="p-1.5 text-surface-400 hover:text-white rounded-lg hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-xs text-surface-400 mb-4 font-mono truncate bg-white/[0.03] p-2 rounded-xl">
          {track.file_name}
        </p>

        {capability?.reason && <p role="status" className="text-xs text-amber-300 mb-4">{capability.reason}</p>}
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label htmlFor={`${formId}-title`} className="block text-xs font-semibold text-surface-400 mb-1.5">
              Track Title
            </label>
            <input id={`${formId}-title`}
              className="glass-input w-full"
              value={form.title}
              onChange={set('title')}
            />
          </div>

          <div>
            <label htmlFor={`${formId}-artist`} className="block text-xs font-semibold text-surface-400 mb-1.5">
              Artist Name
            </label>
            <input id={`${formId}-artist`}
              className="glass-input w-full"
              value={form.artist}
              onChange={set('artist')}
            />
          </div>

          <div>
            <label htmlFor={`${formId}-album`} className="block text-xs font-semibold text-surface-400 mb-1.5">
              Album Title
            </label>
            <input id={`${formId}-album`}
              className="glass-input w-full"
              value={form.album}
              onChange={set('album')}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor={`${formId}-trackNumber`} className="block text-xs font-semibold text-surface-400 mb-1.5">
                Track #
              </label>
              <input id={`${formId}-trackNumber`}
                type="number"
                min="0"
                className="glass-input w-full font-mono"
                value={form.trackNumber}
                onChange={set('trackNumber')}
              />
            </div>
            <div>
              <label htmlFor={`${formId}-year`} className="block text-xs font-semibold text-surface-400 mb-1.5">
                Year
              </label>
              <input id={`${formId}-year`}
                type="number"
                min="0"
                className="glass-input w-full font-mono"
                value={form.year}
                onChange={set('year')}
              />
            </div>
            <div>
              <label htmlFor={`${formId}-genre`} className="block text-xs font-semibold text-surface-400 mb-1.5">
                Genres (; separated)
              </label>
              <input id={`${formId}-genre`}
                className="glass-input w-full"
                value={form.genre}
                onChange={set('genre')}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {['albumArtist', 'composer', 'discNumber', 'discTotal'].map(field => (
              <label key={field} className="block text-xs text-surface-400">
                {{ albumArtist: 'Album Artist', composer: 'Composer', discNumber: 'Disc #', discTotal: 'Total Discs' }[field]}
                <input className="glass-input w-full mt-1" type={field.startsWith('disc') ? 'number' : 'text'} min={field.startsWith('disc') ? '0' : undefined}
                  value={form[field]} onChange={set(field)} />
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-surface-400">
            <input type="checkbox" checked={form.compilation} onChange={e => setForm(f => ({ ...f, compilation: e.target.checked }))} /> Compilation
          </label>
          {error && <p className="text-xs text-rose-400">{error}</p>}

          <div className="pt-2 flex items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || loading || !capability?.enabled}
              className="btn-primary px-5 py-2"
            >
              <Save className="w-4 h-4" />
              <span>{loading ? 'Loading...' : saving ? 'Saving...' : 'Save Tags'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
