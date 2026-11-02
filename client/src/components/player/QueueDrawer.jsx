import { useEffect, useRef, useState, useMemo } from 'react';
import { X, Disc, ListMusic, Volume2, ArrowUp, ArrowDown, ListPlus, GripVertical, MoreHorizontal, ListStart, Play, Pause, Check, ChevronDown } from 'lucide-react';
import { api } from '../../api.js';
import { usePlayer } from '../../context/PlayerContext.jsx';
import { useDialog, hasOpenDialog } from '../../hooks/useDialog.js';
import { CreatePlaylistModal } from '../modals/CreatePlaylistModal.jsx';
const duration = value => `${Math.floor((Number(value) || 0) / 60)}:${String(Math.floor((Number(value) || 0) % 60)).padStart(2, '0')}`;
export function queueSections(order, current) {
  const position = order.indexOf(current);
  return { previous: position >= 0 ? order.slice(0, position) : [], upcoming: order.slice(position + 1) };
}

export function QueueDrawer({ onGoToAlbum, onGoToArtist }) {
  const { queue, queueOrder, queueIndex, setQueueIndex, isPlaying, isQueueOpen, setIsQueueOpen,
    removeFromQueue, clearUpcoming, moveInQueue, togglePlay, shuffle } = usePlayer();
  const [saveTracks, setSaveTracks] = useState(null);
  const [dragIndex, setDragIndex] = useState(null);
  const [dropIndex, setDropIndex] = useState(null);
  const [menu, setMenu] = useState(null);
  const [menuPosition, setMenuPosition] = useState({ top: 100, right: 24 });
  const [showPrevious, setShowPrevious] = useState(false);
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  const [visibleCount, setVisibleCount] = useState(60);
  const more = useRef(null);
  const scroll = useRef(null);
  const { previous, upcoming } = useMemo(() => queueSections(queueOrder, queueIndex), [queueOrder, queueIndex]);
  const remaining = useMemo(() => upcoming.reduce((sum, index) => sum + (Number(queue[index]?.duration) || 0), 0), [queue, upcoming]);
  const panel = useRef(null);
  const menuNode = useRef(null);
  const menuTrigger = useRef(null);
  const modal = useDialog(isQueueOpen && mobile, () => {
    if (menu !== null) { setMenu(null); menuTrigger.current?.focus(); }
    else setIsQueueOpen(false);
  });
  useEffect(() => {
    const resize = () => setMobile(window.innerWidth < 768);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => { setMenu(null); }, [queue, isQueueOpen]);
  useEffect(() => {
    if (!isQueueOpen) return;
    const key = event => {
      if (!mobile && event.key === 'Escape' && !event.defaultPrevented && !hasOpenDialog()) {
        if (menu !== null) { setMenu(null); menuTrigger.current?.focus(); }
        else setIsQueueOpen(false);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [isQueueOpen, mobile, menu, setIsQueueOpen]);
  useEffect(() => {
    if (menu === null) return;
    [...(menuNode.current?.querySelectorAll('button') || [])].find(button => !button.disabled)?.focus();
    const outside = event => {
      if (!menuNode.current?.contains(event.target) && !menuTrigger.current?.contains(event.target)) setMenu(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menu]);
  useEffect(() => { setVisibleCount(60); }, [isQueueOpen]);
  useEffect(() => {
    if (!isQueueOpen || visibleCount >= upcoming.length || !more.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setVisibleCount(count => Math.min(count + 60, upcoming.length));
    }, { root: scroll.current, rootMargin: '120px' });
    observer.observe(more.current);
    return () => observer.disconnect();
  }, [isQueueOpen, visibleCount, upcoming.length]);
  if (!isQueueOpen) return null;
  const current = queue[queueIndex];
  const closeMenu = () => { setMenu(null); menuTrigger.current?.focus(); };
  const move = (from, to) => { moveInQueue(from, to); closeMenu(); };
  const row = (index, position, history = false) => {
    const track = queue[index];
    if (!track) return null;
    const title = track.title || track.file_name;
    const disabled = track.available === false;
    const activeMenu = menu === index;
    return <div key={`${track.id}-${index}`} className={`queue-track ${dragIndex === index ? 'is-dragging' : ''} ${dropIndex === index ? `is-drop-target ${upcoming.indexOf(dragIndex) < position ? 'is-drop-after' : ''}` : ''} ${history ? 'is-history' : ''} ${disabled ? 'is-unavailable' : ''}`}
      draggable={!history} onDragStart={event => { setDragIndex(index); event.dataTransfer?.setData('text/plain', String(index)); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; }}
      onDragEnd={() => { setDragIndex(null); setDropIndex(null); }}
      onDragOver={event => { if (!history && dragIndex !== null && dragIndex !== index) { event.preventDefault(); setDropIndex(index); } else if (dragIndex === index) setDropIndex(null); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDropIndex(null); }} onDrop={event => { event.preventDefault(); if (!history && dragIndex !== null) moveInQueue(dragIndex, index); setDragIndex(null); setDropIndex(null); }}
      onKeyDown={event => {
        if (!event.altKey || history) return;
        const target = event.key === 'ArrowUp' ? upcoming[position - 1] : event.key === 'ArrowDown' ? upcoming[position + 1] : undefined;
        if (target !== undefined) { event.preventDefault(); moveInQueue(index, target); }
      }}>
      <span className="queue-grip" title="Drag to reorder"><GripVertical size={14} /></span>
      <button className="queue-art" onClick={() => setQueueIndex(index)} disabled={disabled} aria-label={`Play ${title}`}>
        {track.cover_path ? <img src={api.coverUrl(track.cover_path)} alt="" draggable="false" /> : <Disc size={19} />}
        <span><Play size={16} fill="currentColor" /></span>
      </button>
      <div className="queue-copy"><button className="queue-title" onClick={() => setQueueIndex(index)} disabled={disabled} title={title}>{title}</button>
        <p>{track.artist || 'Unknown artist'}{disabled && <span> · Unavailable</span>}</p>
      </div>
      <span className="queue-duration">{duration(track.duration)}</span>
      <button className={`player-icon queue-more ${activeMenu ? 'is-open' : ''}`} aria-label={`Actions for ${title}`} aria-expanded={activeMenu}
        onClick={event => {
          menuTrigger.current = event.currentTarget;
          const rect = event.currentTarget.getBoundingClientRect();
          setMenuPosition({ top: Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 240)), right: Math.max(12, window.innerWidth - rect.right) });
          setMenu(activeMenu ? null : index);
        }}><MoreHorizontal size={18} /></button>
      {activeMenu && <div ref={menuNode} className="queue-actions" style={menuPosition} role="group" aria-label={`Queue actions for ${title}`} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeMenu(); } }}>
        {!history && <>
          <button disabled={position === 0} onClick={() => move(index, upcoming[0])}><ListStart size={15} />Play next</button>
          <button disabled={position === 0} onClick={() => move(index, upcoming[position - 1])}><ArrowUp size={15} />Move up</button>
          <button disabled={position === upcoming.length - 1} onClick={() => move(index, upcoming[position + 1])}><ArrowDown size={15} />Move down</button>
        </>}
        <button onClick={() => { removeFromQueue(index); closeMenu(); }}><X size={15} />Remove from queue</button>
        {track.album_id && <button onClick={() => { onGoToAlbum?.({ id: track.album_id, title: track.album }); closeMenu(); if (mobile) setIsQueueOpen(false); }}><Disc size={15} />View album</button>}
      </div>}
    </div>;
  };
  return <>
    <div className="queue-backdrop" onClick={() => setIsQueueOpen(false)} aria-hidden="true" />
    <aside ref={node => { panel.current = node; modal.current = node; }} role={mobile ? 'dialog' : 'complementary'} aria-modal={mobile || undefined}
      aria-label="Play queue" tabIndex={-1} className="queue-panel">
      <header className="queue-panel-header"><h2>Queue <span>{upcoming.length}</span></h2>
        <div><button className="player-icon" onClick={() => setSaveTracks(queueOrder.map(index => queue[index]).filter(Boolean))} disabled={!queue.length} aria-label="Save queue as playlist" title="Save as playlist"><ListPlus size={18} /></button>
          <button className="player-icon" onClick={() => setIsQueueOpen(false)} aria-label="Close queue"><X size={19} /></button></div>
      </header>
      <div ref={scroll} className="queue-panel-scroll" onScroll={() => menu !== null && setMenu(null)}>
        {current && <section className="queue-now"><h3>Now playing</h3><div className="queue-current">
          <button className="queue-current-art" onClick={togglePlay} aria-label={isPlaying ? 'Pause current track' : 'Resume current track'}>
            {current.cover_path ? <img src={api.coverUrl(current.cover_path)} alt="" /> : <Disc size={25} />}
            <span>{isPlaying ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</span>
          </button>
          <div className="queue-copy"><strong>{current.title || current.file_name}</strong><button className="queue-current-artist" onClick={() => onGoToArtist?.({ id: current.artist_id, name: current.artist })} disabled={!current.artist}>{current.artist || 'Unknown artist'}</button></div>
          {isPlaying && <Volume2 size={17} className="queue-playing-icon" />}
        </div></section>}
        <section className="queue-next"><div className="queue-section-heading"><h3>Next up <span>{shuffle ? '· Shuffled' : ''}</span></h3>
          <button onClick={clearUpcoming} disabled={!upcoming.length} aria-label="Clear upcoming tracks">Clear</button></div>
          <p className="queue-reorder-hint" id="queue-reorder-help">Drag to reorder. <span>Alt + ↑ / ↓ also works.</span></p>
          {!upcoming.length ? <div className="queue-empty"><ListMusic size={30} /><h4>All caught up</h4><p>Add songs with “Play next” or “Add to queue”.</p></div>
            : <div className="queue-list" aria-describedby="queue-reorder-help">{upcoming.slice(0, visibleCount).map((index, position) => row(index, position))}</div>}
          {visibleCount < upcoming.length && <button ref={more} className="queue-load-more" onClick={() => setVisibleCount(count => count + 60)}>Show more · {upcoming.length - visibleCount} remaining</button>}
        </section>
        {!!previous.length && <section className="queue-history"><button className="queue-history-toggle" aria-expanded={showPrevious} onClick={() => setShowPrevious(value => !value)}><Check size={14} />Previously played <span>{previous.length}</span><ChevronDown size={15} /></button>
          {showPrevious && <>{previous.length > 60 && <p className="queue-reorder-hint">Most recent 60 tracks</p>}{previous.slice(-60).map((index, position) => row(index, position, true))}</>}</section>}
      </div>
      <footer className="queue-panel-footer"><span>{upcoming.length} {upcoming.length === 1 ? 'track' : 'tracks'} remaining</span><span>{duration(remaining)}</span></footer>
    </aside>
    {saveTracks && <CreatePlaylistModal initialTrackIds={saveTracks.map(track => track.id)} onClose={() => setSaveTracks(null)} />}
  </>;
}
