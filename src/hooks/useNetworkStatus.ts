// Network status detection hook for mobile resilience
//
// No module-scope side effects: listeners are attached lazily on first
// subscription, so the module is safe to import in any environment (SSR,
// tests) and never touches window/navigator at import time.

import { useState, useEffect, useCallback } from 'react';

export type NetworkStatus = {
  isOnline: boolean;
  effectiveType?: 'slow-2g' | '2g' | '3g' | '4g';
  downlink?: number; // Mbps
  rtt?: number; // ms
  saveData?: boolean;
  connectionType?: string;
};

type NetworkChangeListener = (status: NetworkStatus) => void;

let networkListeners: NetworkChangeListener[] = [];
let currentStatus: NetworkStatus = { isOnline: true };
let initialized = false;

function readStatus(): NetworkStatus {
  const connection = (navigator as any).connection;
  return {
    isOnline: navigator.onLine,
    ...(connection
      ? {
          effectiveType: connection.effectiveType,
          downlink: connection.downlink,
          rtt: connection.rtt,
          saveData: connection.saveData,
          connectionType: connection.type,
        }
      : {}),
  };
}

function emit(status: NetworkStatus) {
  currentStatus = status;
  networkListeners.forEach(listener => listener(status));
}

function ensureInitialized() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  currentStatus = readStatus();

  window.addEventListener('online', () => emit(readStatus()));
  window.addEventListener('offline', () => emit({ ...currentStatus, isOnline: false }));

  const connection = (navigator as any).connection;
  if (connection?.addEventListener) {
    connection.addEventListener('change', () => emit(readStatus()));
  }
}

export function useNetworkStatus(): NetworkStatus {
  const [status, setStatus] = useState<NetworkStatus>(() => {
    ensureInitialized();
    return currentStatus;
  });

  useEffect(() => {
    ensureInitialized();
    const listener: NetworkChangeListener = newStatus => setStatus(newStatus);
    networkListeners.push(listener);
    // Sync in case status changed between render and effect
    setStatus(currentStatus);
    return () => {
      networkListeners = networkListeners.filter(l => l !== listener);
    };
  }, []);

  return status;
}

export function useOfflineQueue<T>() {
  const [queue, setQueue] = useState<T[]>([]);
  const { isOnline } = useNetworkStatus();

  const addToQueue = useCallback((item: T) => {
    setQueue(prev => [...prev, item]);
  }, []);

  const clearQueue = useCallback(() => {
    setQueue([]);
  }, []);

  const processQueue = useCallback(
    async (processor: (items: T[]) => Promise<void>) => {
      if (queue.length === 0 || !isOnline) return;
      try {
        await processor([...queue]);
        clearQueue();
      } catch (error) {
        console.error('Failed to process queue:', error);
      }
    },
    [queue, isOnline, clearQueue],
  );

  return {
    queue,
    addToQueue,
    clearQueue,
    processQueue,
    hasQueuedItems: queue.length > 0,
    isOnline,
  };
}

export function isSlowConnection(status: NetworkStatus): boolean {
  return (
    !status.isOnline ||
    status.effectiveType === 'slow-2g' ||
    status.effectiveType === '2g' ||
    (status.downlink !== undefined && status.downlink < 1) || // < 1 Mbps
    (status.rtt !== undefined && status.rtt > 500) // > 500ms RTT
  );
}
