import { useEffect, useRef } from 'react';

const dialogs = [];
export function hasOpenDialog() { return dialogs.length > 0; }
const focusableSelector =
  'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]';

// Only the topmost dialog handles Escape and Tab; nested dialogs restore focus.
export function useDialog(open, onClose) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open || !ref.current) return;
    const node = ref.current;
    const previous = document.activeElement;
    const token = {};
    dialogs.push(token);
    const visible = () =>
      [...node.querySelectorAll(focusableSelector)].filter((el) => el.getClientRects?.().length);
    const elements = visible();
    (
      elements.find(element => element.getAttribute('data-autofocus') !== null) ||
      elements.find((element) => ['INPUT', 'TEXTAREA'].includes(element.tagName)) ||
      elements[0] ||
      node
    ).focus();
    const handler = (event) => {
      if (dialogs[dialogs.length - 1] !== token) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current?.();
      }
      if (event.key === 'Tab') {
        const elements = visible();
        const first = elements[0] || node;
        const last = elements[elements.length - 1] || node;
        if (
          !elements.length ||
          !node.contains(document.activeElement) ||
          (event.shiftKey ? document.activeElement === first : document.activeElement === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      dialogs.splice(dialogs.indexOf(token), 1);
      window.removeEventListener('keydown', handler);
      if (previous && document.contains(previous)) previous.focus?.();
    };
  }, [open]);
  return ref;
}
