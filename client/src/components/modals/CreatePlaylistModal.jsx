import { useState, useEffect, useRef } from 'react';
import { X, ListMusic, Globe, Lock, Loader2 } from 'lucide-react';
import { api } from '../../api.js';
import { toast } from '../layout/Toast.jsx';

export function CreatePlaylistModal({ playlist, onClose, onSaved }) {
  const isEditing = Boolean(playlist?.id);
  const [name, setName] = useState(playlist?.name || '');
  const [comment, setComment] = useState(playlist?.comment || '');
  const [isPublic, setIsPublic] = useState(Boolean(playlist?.is_public));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Please provide a playlist name');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (isEditing) {
        const updated = await api.updatePlaylist(playlist.id, {
          name: trimmedName,
          comment: comment.trim() || null,
          is_public: isPublic,
        });
        toast('Playlist updated', 'success');
        onSaved?.(updated);
      } else {
        const created = await api.createPlaylist({
          name: trimmedName,
          comment: comment.trim() || null,
          is_public: isPublic,
        });
        toast('Playlist created', 'success');
        onSaved?.(created);
      }
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to save playlist');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-fade-in"
      onClick={onClose}
    >
      <div
        className="glass-panel w-full max-w-md rounded-3xl p-6 sm:p-7 border border-white/[0.1] shadow-2xl space-y-6 relative"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-accent/20 border border-accent/30 text-accent flex items-center justify-center">
              <ListMusic className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white tracking-tight">
                {isEditing ? 'Edit Playlist' : 'New Playlist'}
              </h2>
              <p className="text-xs text-surface-400">
                {isEditing ? 'Update playlist details' : 'Create a custom collection of songs'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-surface-400 hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name input */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-surface-300 block">
              Playlist Name <span className="text-accent">*</span>
            </label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Late Night Vibes"
              maxLength={120}
              required
              className="w-full bg-white/[0.04] border border-white/[0.08] focus:border-accent/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder-surface-500 outline-none transition-colors"
            />
          </div>

          {/* Description input */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-surface-300 block">
              Description <span className="text-surface-500 font-normal">(optional)</span>
            </label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="What makes this playlist special?"
              rows={3}
              maxLength={500}
              className="w-full bg-white/[0.04] border border-white/[0.08] focus:border-accent/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder-surface-500 outline-none transition-colors resize-none"
            />
          </div>

          {/* Public / Private toggle */}
          <div
            onClick={() => setIsPublic(!isPublic)}
            className="flex items-center justify-between p-3.5 rounded-2xl bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.04] cursor-pointer transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-white/[0.05] text-surface-300">
                {isPublic ? <Globe className="w-4 h-4 text-emerald-400" /> : <Lock className="w-4 h-4 text-surface-400" />}
              </div>
              <div>
                <p className="text-xs font-semibold text-white">
                  {isPublic ? 'Public Playlist' : 'Private Playlist'}
                </p>
                <p className="text-[11px] text-surface-400">
                  {isPublic ? 'Visible to other users on this server' : 'Only you can view and play'}
                </p>
              </div>
            </div>
            <div
              className={`w-10 h-6 rounded-full transition-colors p-1 flex items-center ${
                isPublic ? 'bg-accent justify-end' : 'bg-surface-700 justify-start'
              }`}
            >
              <div className="w-4 h-4 rounded-full bg-white shadow-sm" />
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2.5 rounded-xl text-xs font-semibold text-surface-400 hover:text-white hover:bg-white/[0.06] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="btn-accent text-xs font-semibold px-5 py-2.5 rounded-xl shadow-glow flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>{isEditing ? 'Save Changes' : 'Create Playlist'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
