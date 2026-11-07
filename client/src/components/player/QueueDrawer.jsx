import { useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import { X, Disc, ListMusic, Volume2, ArrowUp, ArrowDown, ListPlus, GripVertical, MoreHorizontal, ListStart, Play, Pause, Check, ChevronDown, User } from 'lucide-react';
import { parseArtistTokens } from '../common/ArtistLinks.jsx';
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
  useEffect(() => { setMenu(null); }, [queue, queueIndex, isQueueOpen]);
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
  useLayoutEffect(() => {
    if (menu === null || !menuNode.current) return;
    const rect = menuNode.current.getBoundingClientRect();
    setMenuPosition(position => ({
      top: Math.max(12, Math.min(position.top, window.innerHeight - rect.height - 12)),
      right: Math.max(12, Math.min(position.right, window.innerWidth - rect.width - 12)),
    }));
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
  const navigateToArtist = artist => {
    onGoToArtist?.(artist);
    setMenu(null);
    if (mobile) setIsQueueOpen(false);
  };
  const artistLinks = (track, className = '') => <span className={className}>
    {track.artist ? parseArtistTokens(track.artist).map((part, index) => {
      if (index % 2) return part;
      const name = part.trim();
      if (!name) return null;
      const artist = { id: index === 0 ? track.artist_id : undefined, name };
      return <a key={index} className="queue-artist-link" href={`/artist/${encodeURIComponent(artist.id || name)}`}
        title={`Go to artist: ${name}`} onDoubleClick={event => event.stopPropagation()}
        onClick={event => {
          event.stopPropagation();
          if (!onGoToArtist || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
          event.preventDefault();
          navigateToArtist(artist);
        }}>{part}</a>;
    }) : 'Unknown artist'}
  </span>;
  const openMenu = (index, event, context = false) => {
    event.preventDefault();
    event.stopPropagation();
    const trigger = context ? event.currentTarget.querySelector?.('.queue-more') || event.currentTarget : event.currentTarget;
    menuTrigger.current = trigger;
    const rect = trigger.getBoundingClientRect();
    const pointer = context && (event.clientX || event.clientY);
    setMenuPosition({
      top: Math.max(12, pointer ? event.clientY : rect.bottom + 6),
      right: Math.max(12, window.innerWidth - (pointer ? event.clientX + 220 : rect.right)),
    });
    setMenu(!context && menu === index ? null : index);
  };
  const doubleClick = (index, event) => {
    if (event.target?.closest?.('button, a, .queue-actions')) return;
    if (queue[index]?.available !== false) { setMenu(null); setQueueIndex(index); }
  };
  const actions = (index, position, history) => {
    const track = queue[index];
    return <div ref={menuNode} className="queue-actions" style={menuPosition} role="group" aria-label={`Queue actions for ${track.title || track.file_name}`}
      onDoubleClick={event => event.stopPropagation()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); }
        else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          const items = [...menuNode.current.querySelectorAll('button:not(:disabled)')];
          const current = items.indexOf(document.activeElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}>
      <button disabled={track.available === false} onClick={() => { setQueueIndex(index); closeMenu(); }}><Play size={15} />Play now</button>
      {!history && <>
        <button disabled={position === 0} onClick={() => move(index, upcoming[0])}><ListStart size={15} />Play next</button>
        <button disabled={position === 0} onClick={() => move(index, upcoming[position - 1])}><ArrowUp size={15} />Move up</button>
        <button disabled={position === upcoming.length - 1} onClick={() => move(index, upcoming[position + 1])}><ArrowDown size={15} />Move down</button>
      </>}
      <button onClick={() => { removeFromQueue(index); closeMenu(); }}><X size={15} />Remove from queue</button>
      {track.artist && <button onClick={() => navigateToArtist({ id: track.artist_id, name: track.artist })}><User size={15} />View artist</button>}
      {track.album_id && <button onClick={() => { onGoToAlbum?.({ id: track.album_id, title: track.album }); closeMenu(); if (mobile) setIsQueueOpen(false); }}><Disc size={15} />View album</button>}
    </div>;
  };
  const row = (index, position, history = false) => {
    const track = queue[index];
    if (!track) return null;
    const title = track.title || track.file_name;
    const disabled = track.available === false;
    const activeMenu = menu === index;
    return <div key={`${track.id}-${index}`} className={`queue-track ${dragIndex === index ? 'is-dragging' : ''} ${dropIndex === index ? `is-drop-target ${upcoming.indexOf(dragIndex) < position ? 'is-drop-after' : ''}` : ''} ${history ? 'is-history' : ''} ${disabled ? 'is-unavailable' : ''}`}
      onContextMenu={event => openMenu(index, event, true)} onDoubleClick={event => doubleClick(index, event)}
      draggable={!history} onDragStart={event => { setDragIndex(index); event.dataTransfer?.setData('text/plain', String(index)); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; }}
      onDragEnd={() => { setDragIndex(null); setDropIndex(null); }}
      onDragOver={event => { if (!history && dragIndex !== null && dragIndex !== index) { event.preventDefault(); setDropIndex(index); } else if (dragIndex === index) setDropIndex(null); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDropIndex(null); }} onDrop={event => { event.preventDefault(); if (!history && dragIndex !== null) moveInQueue(dragIndex, index); setDragIndex(null); setDropIndex(null); }}
      tabIndex={0}
      onKeyDown={event => {
        if (event.key === 'Enter' && event.target === event.currentTarget && !disabled) { event.preventDefault(); setMenu(null); setQueueIndex(index); return; }
        if (!event.altKey || history) return;
        const target = event.key === 'ArrowUp' ? upcoming[position - 1] : event.key === 'ArrowDown' ? upcoming[position + 1] : undefined;
        if (target !== undefined) { event.preventDefault(); moveInQueue(index, target); }
      }}>
      <span className="queue-grip" title="Drag to reorder · Alt + ↑ / ↓"><GripVertical size={14} /></span>
      <button className="queue-art" onClick={() => setQueueIndex(index)} disabled={disabled} aria-label={`Play ${title}`}>
        {track.cover_path ? <img src={api.coverUrl(track.cover_path)} alt="" draggable="false" /> : <Disc size={19} />}
        <span><Play size={16} fill="currentColor" /></span>
      </button>
      <div className="queue-copy"><span className="queue-title" title={title}>{title}</span>
        <p>{artistLinks(track)}{disabled && <span> · Unavailable</span>}</p>
      </div>
      <span className="queue-duration">{duration(track.duration)}</span>
      <button className={`player-icon queue-more ${activeMenu ? 'is-open' : ''}`} aria-label={`Actions for ${title}`} aria-expanded={activeMenu}
        onClick={event => openMenu(index, event)}><MoreHorizontal size={18} /></button>
      {activeMenu && actions(index, position, history)}
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
        {current && <section className="queue-now"><h3>Now playing</h3><div className="queue-current" onContextMenu={event => openMenu(queueIndex, event, true)} onDoubleClick={event => doubleClick(queueIndex, event)}>
          <button className="queue-current-art" onClick={togglePlay} aria-label={isPlaying ? 'Pause current track' : 'Resume current track'}>
            {current.cover_path ? <img src={api.coverUrl(current.cover_path)} alt="" /> : <Disc size={25} />}
            <span>{isPlaying ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</span>
          </button>
          <div className="queue-copy"><strong>{current.title || current.file_name}</strong>{artistLinks(current, 'queue-current-artist')}</div>
          {isPlaying && <Volume2 size={17} className="queue-playing-icon" />}
          <button className={`player-icon queue-more ${menu === queueIndex ? 'is-open' : ''}`} aria-label={`Actions for ${current.title || current.file_name}`} aria-expanded={menu === queueIndex}
            onClick={event => openMenu(queueIndex, event)}><MoreHorizontal size={18} /></button>
          {menu === queueIndex && actions(queueIndex, -1, true)}
        </div></section>}
        <section className="queue-next"><div className="queue-section-heading"><h3>Next up <span>{shuffle ? '· Shuffled' : ''}</span></h3>
          <button onClick={clearUpcoming} disabled={!upcoming.length} aria-label="Clear upcoming tracks">Clear</button></div>
          {!upcoming.length ? <div className="queue-empty"><ListMusic size={30} /><h4>All caught up</h4><p>Add songs with “Play next” or “Add to queue”.</p></div>
            : <div className="queue-list">{upcoming.slice(0, visibleCount).map((index, position) => row(index, position))}</div>}
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
