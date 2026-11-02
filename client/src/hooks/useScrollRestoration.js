import { useLayoutEffect, useRef } from 'react';

const positions = new Map();
export function useScrollRestoration(key) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const target = positions.get(key) || 0;
    let restoring = true;
    let lastPosition = target;
    const restore = () => {
      if (!restoring) return;
      node.scrollTop = target;
      if (node.scrollHeight >= target + node.clientHeight) stop();
    };
    let observer;
    const stop = () => {
      restoring = false;
      observer?.disconnect();
    };
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(restore);
      // Views replace their skeleton after loading, so observe the main element
      // and any subsequently inserted children.
      observer.observe(node);
    }
    const mutation = typeof MutationObserver !== 'undefined' ? new MutationObserver(restore) : null;
    mutation?.observe(node, { childList: true, subtree: true });
    restore();
    const timer = setTimeout(stop, 5000);
    const remember = () => {
      if (!restoring) lastPosition = node.scrollTop;
    };
    node.addEventListener('scroll', remember, { passive: true });
    node.addEventListener('wheel', stop, { passive: true });
    node.addEventListener('touchstart', stop, { passive: true });
    return () => {
      positions.set(key, lastPosition);
      stop();
      mutation?.disconnect();
      clearTimeout(timer);
      node.removeEventListener('scroll', remember);
      node.removeEventListener('wheel', stop);
      node.removeEventListener('touchstart', stop);
    };
  }, [key]);
  return ref;
}
