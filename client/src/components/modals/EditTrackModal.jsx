import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Save, Edit3 } from 'lucide-react';
import { api } from '../../api.js';
import { toast } from '../layout/Toast.jsx';

export function EditTrackModal({ track, onClose, onSaved }) {
  const [form, setForm] = useState({
    title: track.title || '',
    artist: track.artist || '',
    album: track.album || '',
    trackNumber: track.track_number || '',
    genre: track.genre || '',
    year: track.year || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = {};
      if (form.title !== (track.title || '')) payload.title = form.title;
      if (form.artist !== (track.artist || '')) payload.artist = form.artist;
      if (form.album !== (track.album || '')) payload.album = form.album;
      if (String(form.trackNumber) !== String(track.track_number || '')) {
        payload.trackNumber = form.trackNumber ? parseInt(form.trackNumber, 10) : null;
      }
      if (form.genre !== (track.genre || '')) payload.genre = form.genre;
      if (String(form.year) !== String(track.year || '')) {
        payload.year = form.year ? parseInt(form.year, 10) : null;
      }
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
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-fade-in"
      onClick={onClose}
    >
      <div
        className="glass-panel w-full max-w-md rounded-3xl p-6 sm:p-7 shadow-glass-lg border border-white/[0.1] relative select-none animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-4 border-b border-white/[0.08] mb-5">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <Edit3 className="w-4 h-4 text-accent" />
            <span>Edit ID3 Tags</span>
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 text-surface-400 hover:text-white rounded-lg hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-xs text-surface-400 mb-4 font-mono truncate bg-white/[0.03] p-2 rounded-xl">
          {track.file_name}
        </p>

        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-surface-400 mb-1.5">
              Track Title
            </label>
            <input
              className="glass-input w-full"
              value={form.title}
              onChange={set('title')}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-surface-400 mb-1.5">
              Artist Name
            </label>
            <input
              className="glass-input w-full"
              value={form.artist}
              onChange={set('artist')}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-surface-400 mb-1.5">
              Album Title
            </label>
            <input
              className="glass-input w-full"
              value={form.album}
              onChange={set('album')}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-surface-400 mb-1.5">
                Track #
              </label>
              <input
                type="number"
                min="0"
                className="glass-input w-full font-mono"
                value={form.trackNumber}
                onChange={set('trackNumber')}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-surface-400 mb-1.5">
                Year
              </label>
              <input
                type="number"
                min="0"
                className="glass-input w-full font-mono"
                value={form.year}
                onChange={set('year')}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-surface-400 mb-1.5">
                Genre
              </label>
              <input
                className="glass-input w-full"
                value={form.genre}
                onChange={set('genre')}
              />
            </div>
          </div>

          {error && <p className="text-xs text-rose-400">{error}</p>}

          <div className="pt-2 flex items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="btn-primary px-5 py-2"
            >
              <Save className="w-4 h-4" />
              <span>{saving ? 'Saving...' : 'Save Tags'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
