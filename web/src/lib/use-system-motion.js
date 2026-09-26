import { useEffect, useState } from 'react';

export function useSystemMotion() {
  const [motion, setMotion] = useState(() => typeof window !== 'undefined' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setMotion(!preference.matches);
    change();
    preference.addEventListener('change', change);
    return () => preference.removeEventListener('change', change);
  }, []);
  return motion;
}
