/** A native, keyboard-accessible range with the same quiet track in every browser. */
export function RangeControl({ value = 0, max = 1, step = 0.01, onChange, label, valueText, className = '' }) {
  const end = Number.isFinite(max) && max > 0 ? max : 0;
  const current = Math.max(0, Math.min(Number(value) || 0, end));
  return <input type="range" min="0" max={end} step={step} value={current}
    disabled={!end} onChange={event => onChange(Number(event.target.value))}
    aria-label={label} aria-valuetext={valueText}
    className={`playback-range ${className}`}
    style={{ '--range-progress': `${end ? current / end * 100 : 0}%` }} />;
}
