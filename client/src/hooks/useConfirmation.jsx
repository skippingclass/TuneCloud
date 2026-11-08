import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';
import { useDialog } from './useDialog.js';

function Confirmation({ request, finish }) {
  const titleId = useId();
  const descriptionId = useId();
  const ref = useDialog(true, () => finish(false));
  return createPortal(<div className="tc-confirm-backdrop" onClick={event => { if (event.target === event.currentTarget) finish(false); }}>
    <div ref={ref} className="tc-confirm" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
      <div className="tc-confirm-icon"><Trash2 size={22} /></div>
      <h2 id={titleId}>{request.title}</h2>
      <p id={descriptionId}>{request.description}</p>
      <div className="tc-confirm-actions">
        <button className="btn-glass" data-autofocus onClick={() => finish(false)}>Cancel</button>
        <button className="tc-confirm-delete" onClick={() => finish(true)}>{request.confirmLabel || 'Delete'}</button>
      </div>
    </div>
  </div>, document.body);
}

export function useConfirmation() {
  const [request, setRequest] = useState(null);
  const pending = useRef(null);
  const confirm = useCallback(options => new Promise(resolve => {
    pending.current?.(false);
    pending.current = resolve;
    setRequest(options);
  }), []);
  const finish = useCallback(result => {
    pending.current?.(result); pending.current = null; setRequest(null);
  }, []);
  useEffect(() => () => { pending.current?.(false); }, []);
  return { confirm, confirmation: request ? <Confirmation request={request} finish={finish} /> : null };
}
