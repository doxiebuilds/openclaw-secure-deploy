import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';


export function useAutoScroll() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = containerRef.current;
    if (!el) return;
    followingRef.current = true;
    setFollowing(true);
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);


  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);


  useEffect(() => {
    const root = containerRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        followingRef.current = entry.isIntersecting;
        setFollowing(entry.isIntersecting);
      },
      { root, rootMargin: '0px 0px 48px 0px', threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const content = contentRef.current;
    const el = containerRef.current;
    if (!content || !el) return;

    const observer = new ResizeObserver(() => {
      if (followingRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return { containerRef, sentinelRef, contentRef, following, scrollToBottom };
}
