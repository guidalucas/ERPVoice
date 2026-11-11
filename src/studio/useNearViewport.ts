import { useEffect, useRef, useState } from 'react';

export function useNearViewport<T extends HTMLElement>(lazy = true) {
  const placeholder = useRef<T>(null);
  const [near, setNear] = useState(!lazy);
  const shouldLoad = !lazy || near || typeof IntersectionObserver === 'undefined';
  useEffect(() => {
    if (!lazy) {
      setNear(true);
      return;
    }
    const element = placeholder.current;
    if (shouldLoad || !element) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setNear(true);
        observer.disconnect();
      }
    }, { rootMargin: '200px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [lazy, shouldLoad]);
  return { placeholder, shouldLoad };
}
