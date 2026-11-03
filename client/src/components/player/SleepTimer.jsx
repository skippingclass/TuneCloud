import { useEffect, useRef, useState, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { Moon, Check, Music2, X } from 'lucide-react';
import { usePlayer } from '../../context/PlayerContext.jsx';
import { useDialog } from '../../hooks/useDialog.js';

export function timerRemaining(until, now = Date.now()) {
  if (typeof until !== 'number') return '';
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function SleepTimer({ compact = false, className = '' }) {
  const { sleepUntil, setSleepTimer } = usePlayer();
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState('');
  const [now, setNow] = useState(Date.now());
  const [position, setPosition] = useState({ right: 16, bottom: 112 });
  const descriptionId = useId();
  const trigger = useRef(null);
  const dialog = useDialog(open, () => setOpen(false));
  useEffect(() => {
    if (typeof sleepUntil !== 'number') return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [sleepUntil]);
  const active = Boolean(sleepUntil);
  const remaining = timerRemaining(sleepUntil, now);
  const start = value => { setSleepTimer(value); setOpen(false); setMinutes(''); };
  const placePanel = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) {
      const horizontal = rect.left < window.innerWidth / 2
        ? { left: Math.max(12, Math.min(rect.left, window.innerWidth - 316)) }
        : { right: Math.max(12, Math.min(window.innerWidth - rect.right, window.innerWidth - 316)) };
      setPosition(rect.top > 440 ? { ...horizontal, bottom: window.innerHeight - rect.top + 12 }
        : { ...horizontal, top: Math.min(rect.bottom + 12, Math.max(12, window.innerHeight - 440)) });
    }
  }, []);
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', placePanel);
    return () => window.removeEventListener('resize', placePanel);
  }, [open, placePanel]);
  const toggle = () => {
    placePanel();
    setOpen(value => !value);
  };
  return <>
    <button ref={trigger} type="button" onClick={toggle}
      aria-label="Sleep timer" aria-describedby={active ? descriptionId : undefined} aria-haspopup="dialog" aria-expanded={open}
      className={`sleep-trigger ${active ? 'is-active' : ''} ${compact ? 'is-compact' : ''} ${className}`}
      title={active ? `Sleep timer: ${sleepUntil === 'track' ? 'end of this track' : remaining}` : 'Sleep timer'}>
      <Moon size={17} aria-hidden="true" />
      {!compact && <span>Sleep timer</span>}
      {active && <span id={descriptionId} className="sleep-trigger-value">{sleepUntil === 'track' ? (compact ? 'Track' : 'End of track') : remaining}</span>}
    </button>
    {open && createPortal(<>
      <div className="sleep-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Sleep timer settings"
        tabIndex={-1} className="sleep-dialog" style={{ ...position, maxHeight: `calc(100dvh - ${(position.top ?? position.bottom) + 12}px)` }}>
        <div className="sleep-heading"><div className="sleep-moon"><Moon size={21} /></div>
          <div><h2>Sleep timer</h2><p>Let the music wind down.</p></div>
          <button type="button" className="player-icon" onClick={() => setOpen(false)} aria-label="Close sleep timer"><X size={16} /></button>
        </div>
        {active && <div className="sleep-status" role="status">
          <span>{sleepUntil === 'track' ? 'Pauses when this track ends' : 'Playback pauses in'}</span>
          {remaining && <strong>{remaining}</strong>}
        </div>}
        <p className="sleep-section-label">Pause playback after</p>
        <div className="sleep-presets">{[15, 30, 45, 60, 90].map(value =>
          <button type="button" key={value} data-autofocus={value === 15 ? true : undefined} onClick={() => start(value)} aria-label={`Sleep in ${value} minutes`}>
            <strong>{value}</strong><span>min</span>
          </button>)}</div>
        <form className="sleep-custom" onSubmit={event => { event.preventDefault(); if (Number.isInteger(Number(minutes)) && Number(minutes) >= 1 && Number(minutes) <= 480) start(Number(minutes)); }}>
          <label><span>Custom</span><input type="number" min="1" max="480" step="1" placeholder="Minutes" aria-label="Custom sleep minutes" value={minutes} onChange={event => setMinutes(event.target.value)} /></label>
          <button type="submit" disabled={!Number.isInteger(Number(minutes)) || Number(minutes) < 1 || Number(minutes) > 480}>Set timer</button>
        </form>
        <button type="button" className={`sleep-track ${sleepUntil === 'track' ? 'is-selected' : ''}`} onClick={() => start('track')}>
          <Music2 size={17} /><span>End of this track</span>{sleepUntil === 'track' && <Check size={16} />}
        </button>
        {active && <button type="button" className="sleep-cancel" onClick={() => start(null)}>Turn off timer</button>}
        <p className="sleep-footnote">Your queue stays right where you left it.</p>
      </div>
    </>, document.fullscreenElement || document.body)}
  </>;
}
