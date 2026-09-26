import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Pause, Clock3, X, CircleAlert, Minus } from 'lucide-react';
import { createWireMotion } from './flow-motion.js';
import { useSystemMotion } from '../lib/use-system-motion.js';
import { CompletionStroke } from './completion-stroke.jsx';

const symbols = {running:'progress', complete:'progress', failed:'error', approval:'pause', waiting:'clock', cached:'clock', cancelled:'cancel', blocked:'minus', stopped:'minus'};
const icons = {error:CircleAlert, pause:Pause, clock:Clock3, cancel:X, minus:Minus};

function ActivityIcon({symbol, state, active, motion, initial, onExit}) {
  const element = useRef(null);
  const animation = useRef(null);
  const progressState = useRef(state);
  if (state === 'running' || state === 'complete') progressState.current = state;
  useLayoutEffect(() => {
    const node = element.current;
    const style = getComputedStyle(node);
    // Read the visible pose before cancelling, so rapid changes never reset it.
    const from = {opacity:style.opacity, transform:style.transform};
    animation.current?.cancel();
    animation.current = null;
    const to = {opacity:active ? '1' : '0', transform:active ? 'scale(1)' : 'scale(.88)'};
    Object.assign(node.style, to);
    if (!motion || initial) {
      if (!active) onExit(symbol);
      return;
    }
    const next = node.animate([from, to], {
      duration:active ? 160 : 120, easing:'cubic-bezier(.2,.8,.2,1)'
    });
    animation.current = next;
    next.onfinish = () => {
      if (animation.current !== next) return;
      animation.current = null;
      if (!active) onExit(symbol);
    };
  }, [active, motion, initial, symbol, onExit]);
  useLayoutEffect(() => () => {
    animation.current?.cancel();
    animation.current = null;
  }, []);
  const Icon = icons[symbol];
  return <span ref={element} className="activity-icon" data-symbol={symbol} data-active={active}>
    {symbol === 'progress' ? <CompletionStroke complete={progressState.current === 'complete'} motion={motion}/> : Icon ? <Icon/> : <span>{symbol.slice(7)}</span>}
  </span>;
}

export function ActivityMark({state = 'idle', number, light = true, motion}) {
  const systemMotion = useSystemMotion();
  const animate = motion ?? systemMotion;
  const symbol = symbols[state] ?? `number:${number ?? '·'}`;
  const [layers, setLayers] = useState([symbol]);
  const mounted = useRef(false);
  const desired = useRef(symbol);
  desired.current = symbol;
  // Retain outgoing symbols only until their fade ends; reuse one if it returns.
  if (!layers.includes(symbol)) setLayers([...layers, symbol]);
  const remove = useCallback(exited => setLayers(current => desired.current === exited ? current : current.filter(layer => layer !== exited)), []);
  useLayoutEffect(() => {mounted.current = true;}, []);
  return <span className="activity-mark" data-state={state} data-light={light} data-motion={animate} aria-hidden="true">
    {layers.map(layer => <ActivityIcon key={layer} symbol={layer} state={state} active={layer === symbol} motion={animate} initial={!mounted.current} onExit={remove}/>)}
  </span>;
}

export const stateLabels = {idle:'Not started',queued:'Queued',running:'Running',complete:'Complete',failed:'Failed',approval:'Approval required',waiting:'Waiting',cached:'Cached',cancelled:'Cancelled',blocked:'Blocked',stopped:'Stopped'};

// Paths express dependencies or a shared dispatch bus. Light never invents an edge.
export function ActivityFlow({items, ordered, review, light, motion}) {
  const systemMotion = useSystemMotion();
  const animate = motion ?? systemMotion;
  const root = useRef(null);
  const wires = useRef(null);
  const [lit, setLit] = useState([]);
  const topology = `${ordered}:${review}:${items.map(item=>item.id).join(',')}`;
  useLayoutEffect(() => {
    const elements = new Map([...root.current.querySelectorAll('[data-wire]')].map(element => [Number(element.dataset.wire), element]));
    wires.current = createWireMotion(elements, setLit);
    return () => wires.current.dispose();
  }, [topology]);
  useLayoutEffect(() => {
    wires.current.update(light ? items.flatMap((item,i) => item.state === 'running' && (!ordered || i > 0) ? [i] : []) : [], animate && light);
  }, [items, ordered, light, animate, topology]);
  const gap = 1000 / items.length;
  const x = i => gap * (i + .5);
  const edges = ordered ? items.slice(1).map((_, i) => ({from: review && i === 2 ? 0 : i, to: i + 1})) : items.map((_, i) => ({from:null,to:i}));
  return <div className="activity-flow" data-light={light} ref={root}>
    <svg className="activity-wires" viewBox="0 0 1000 72" preserveAspectRatio="none" aria-hidden="true">
      {!ordered && <path d={`M${x(0)} 12H${x(items.length - 1)}`} className="activity-wire"/>}
      {edges.map(({from,to}) => {
        const d = from === null ? `M${x(to)} 12V46` : review && to === 3 ? `M${x(from)} 46V12H${x(to)}V46` : `M${x(from)} 46H${x(to)}`;
        return <g key={to}><path d={d} className="activity-wire" data-complete={items[to].state === 'complete'}/><g data-wire={to} className="activity-flight">
          <path d={d} pathLength="100" className="activity-current activity-current-halo"/>
          <path d={d} pathLength="100" className="activity-current"/>
        </g></g>;
      })}
    </svg>
    <div className="activity-nodes" style={{gridTemplateColumns:`repeat(${items.length},minmax(0,1fr))`}}>
      {items.map((item,i)=><div key={item.id} className="activity-node" data-state={item.state}>
        <ActivityMark state={item.state} number={i + 1} motion={animate} light={light && (ordered && i === 0 && item.state === 'running' || lit.includes(i))}/><span>{item.label}</span>
      </div>)}
    </div>
  </div>;
}
