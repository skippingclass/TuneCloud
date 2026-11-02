import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { toast } from '../components/layout/Toast.jsx';

export function useLibraryScan(onScanComplete) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const completeRef = useRef(onScanComplete);
  completeRef.current = onScanComplete;
  const pollRef = useRef(null);
  const activeRef = useRef(false);
  const timerRef = useRef(null);
  const controllerRef = useRef(null);
  const wasScanning = useRef(false);
  const notifyRef = useRef(false);
  const startingRef = useRef(false);

  useEffect(() => {
    activeRef.current = true;
    const poll = async () => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        const status = await api.scanStatus({ signal: controller.signal });
        if (!activeRef.current || controller.signal.aborted) return;
        setConnectionLost(false);
        if (status.isScanning) {
          wasScanning.current = true;
          setScanning(status.progress?.full ? 'full' : 'incremental');
          setProgress(status.progress);
          timerRef.current = setTimeout(poll, 1200);
        } else {
          setScanning(false);
          setProgress(null);
          if (wasScanning.current) {
            wasScanning.current = false;
            if (status.progress?.phase === 'error' && notifyRef.current)
              toast(`Scan failed: ${status.progress.error}`, 'error');
            else if (status.progress?.phase !== 'error') {
              const result = status.lastResult || {};
              if (notifyRef.current)
                toast(
                  `Scan complete: ${result.processed || 0} tracks, ${result.covers || 0} covers in ${result.durationSeconds || 0}s`,
                  'success',
                );
              completeRef.current?.();
            }
            notifyRef.current = false;
          }
        }
      } catch (err) {
        if (!activeRef.current || controller.signal.aborted) return;
        setConnectionLost(true);
        timerRef.current = setTimeout(poll, 3000);
      }
    };
    pollRef.current = poll;
    poll();
    return () => {
      activeRef.current = false;
      controllerRef.current?.abort();
      clearTimeout(timerRef.current);
    };
  }, []);

  const startScan = useCallback(async ({ full = false, reextractCovers = false } = {}) => {
    if (wasScanning.current || startingRef.current) return;
    startingRef.current = true;
    clearTimeout(timerRef.current);
    controllerRef.current?.abort();
    setScanning(full ? 'full' : 'incremental');
    setProgress({ phase: 'starting' });
    try {
      await api.scan({ full, reextractCovers });
      if (!activeRef.current) return;
      wasScanning.current = true;
      notifyRef.current = true;
      timerRef.current = setTimeout(() => pollRef.current?.(), 800);
    } catch (err) {
      if (!activeRef.current) return;
      setScanning(false);
      setProgress(null);
      toast(`Could not start scan: ${err.message}`, 'error');
    } finally {
      startingRef.current = false;
    }
  }, []);
  return { scanning, progress, connectionLost, startScan };
}
