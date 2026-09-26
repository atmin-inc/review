import { useLayoutEffect, useRef } from 'react';
import { useSystemMotion } from '../lib/use-system-motion.js';

// Measure real content, including wrapped text. Retarget from the visible height.
export function AutoHeight({children, motion, as: Element = 'div', ...props}) {
  const systemMotion = useSystemMotion();
  const animate = motion ?? systemMotion;
  const host = useRef(null);
  const content = useRef(null);
  useLayoutEffect(() => {
    const element = host.current;
    const inner = content.current;
    let previous = inner.getBoundingClientRect().height;
    let animation;
    const observer = new ResizeObserver(() => {
      const next = inner.getBoundingClientRect().height;
      if (Math.abs(next - previous) < .5) return;
      const from = animation ? element.getBoundingClientRect().height -
        (element.offsetHeight - element.clientHeight) : previous;
      previous = next;
      animation?.cancel();
      // Nested regions already ease their height; let this parent follow them.
      if (!animate || inner.querySelector('[data-resizing="true"]')) {
        animation = null;
        element.style.height = '';
        delete element.dataset.resizing;
        return;
      }
      element.dataset.resizing = 'true';
      element.style.height = `${next}px`;
      animation = element.animate([{height:`${from}px`}, {height:`${next}px`}], {
        duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)'
      });
      animation.onfinish = () => {
        animation = null;
        element.style.height = '';
        delete element.dataset.resizing;
      };
    });
    observer.observe(inner);
    return () => {
      observer.disconnect();
      animation?.cancel();
      element.style.height = '';
      delete element.dataset.resizing;
    };
  }, [animate]);
  return <Element {...props} ref={host} data-auto-height="" style={{...props.style, boxSizing:'content-box'}}>
    <div ref={content} className="auto-height-content">{children}</div>
  </Element>;
}
