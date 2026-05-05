import { useEffect, useRef } from 'react';

/** Calls callback on a fixed interval. Cleans up automatically on unmount. */
export function useInterval(callback: () => void, delayMs: number): void {
  const saved = useRef(callback);
  useEffect(() => { saved.current = callback; }, [callback]);
  useEffect(() => {
    const id = setInterval(() => saved.current(), delayMs);
    return () => clearInterval(id);
  }, [delayMs]);
}
