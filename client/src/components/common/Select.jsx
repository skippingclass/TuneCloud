import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export function Select({ id, label, value, options, onChange, className = '', disabled = false }) {
  const generated = useId();
  const listId = `${id || generated}-options`;
  const trigger = useRef(null);
  const menu = useRef(null);
  const items = useRef([]);
  const search = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false);
  const selected = options.findIndex(option => String(option.value) === String(value));
  const [active, setActive] = useState(Math.max(0, selected));
  const [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 300, minWidth: 180 });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = trigger.current.getBoundingClientRect();
      const width = Math.min(Math.max(box.width, 200), window.innerWidth - 16);
      const below = window.innerHeight - box.bottom - 12;
      const above = box.top - 12;
      const flip = below < 180 && above > below;
      const height = Math.max(48, Math.min(320, flip ? above : below));
      setPosition({ left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)), width,
        maxHeight: height, top: flip ? undefined : box.bottom + 6,
        bottom: flip ? window.innerHeight - box.top + 6 : undefined });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = event => {
      if (!trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  useEffect(() => { if (open) items.current[active]?.scrollIntoView?.({ block: 'nearest' }); }, [open, active]);

  const choose = index => {
    if (!options[index] || options[index].disabled) return;
    onChange(options[index].value);
    setOpen(false);
    trigger.current?.focus();
  };
  const move = direction => {
    for (let step = 1; step <= options.length; step++) {
      const index = (active + direction * step + options.length) % options.length;
      if (!options[index].disabled) { setActive(index); break; }
    }
  };
  const keyDown = event => {
    if (event.key === 'Tab') { setOpen(false); return; }
    if (event.key === 'Escape') { if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false); } return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      if (!open) { setActive(Math.max(0, selected)); setOpen(true); return; }
      if (event.key === 'Enter' || event.key === ' ') choose(active);
      else if (event.key === 'Home') setActive(options.findIndex(option => !option.disabled));
      else if (event.key === 'End') setActive(options.findLastIndex(option => !option.disabled));
      else move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const text = now - search.current.time > 700 ? event.key : search.current.text + event.key;
      search.current = { text, time: now };
      const index = options.findIndex(option => !option.disabled && String(option.label).toLowerCase().startsWith(text.toLowerCase()));
      if (index >= 0) { event.preventDefault(); setActive(index); setOpen(true); }
    }
  };

  return <>
    <button type="button" id={id} ref={trigger} role="combobox" aria-label={label} aria-expanded={open}
      aria-haspopup="listbox" aria-controls={open ? listId : undefined} aria-activedescendant={open ? `${listId}-${active}` : undefined}
      disabled={disabled || !options.length} onKeyDown={keyDown}
      onClick={() => { setActive(Math.max(0, selected)); setOpen(value => !value); search.current.text = ''; }}
      className={`tc-select ${className}`}>
      <span>{options[selected]?.label ?? 'Choose…'}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={menu} id={listId} role="listbox" aria-label={label} style={position} className="tc-select-menu">
      {options.map((option, index) => <div key={option.value} id={`${listId}-${index}`} role="option"
        ref={node => { items.current[index] = node; }} aria-selected={String(option.value) === String(value)} aria-disabled={option.disabled || undefined}
        className={`tc-select-option ${active === index ? 'is-active' : ''}`}
        onPointerMove={() => !option.disabled && setActive(index)} onPointerDown={event => event.preventDefault()} onClick={() => choose(index)}>
        <span>{option.label}</span>{String(option.value) === String(value) && <Check size={15} aria-hidden="true" />}
      </div>)}
    </div>, document.body)}
  </>;
}
