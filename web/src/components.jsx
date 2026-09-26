// Small compositions of the kit's components shared by every screen.
import { createContext, useContext, useState } from 'react';
import { CircleAlert, ExternalLink as ExternalIcon, Info } from 'lucide-react';
import { ActivityMark } from './ui/activity.jsx';
import { Label } from './ui/label.jsx';
import { cn } from './lib/utils.js';
import { runStates, share } from './format.js';
import frontInk from '../brand/atmin-front-ink.svg';
import frontPaper from '../brand/atmin-front-paper.svg';
import boxInk from '../brand/atmin-box-ink.svg';
import boxPaper from '../brand/atmin-box-paper.svg';

export const Navigation = createContext(() => {});

// In-app link: a plain anchor that navigates without a page load on an unmodified click.
export function Link({ href, onClick, ...props }) {
  const navigate = useContext(Navigation);
  return <a href={href} {...props} onClick={event => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  }}/>;
}

export function ExternalLink({ href, children, className, icon = true }) {
  return <a href={href} target="_blank" rel="noreferrer" className={cn('link inline-flex items-center gap-1', className)}>
    {children}{icon && <ExternalIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground"/>}
  </a>;
}

// The front mark for compact UI, the box mark where the logo leads. Ink on light, paper on dark.
export function Mark({ size = 24, box = false }) {
  const [light, dark] = box ? [boxInk, boxPaper] : [frontInk, frontPaper];
  const width = box ? Math.round(size * 686.31 / 746.49) : size;
  return <>
    <img src={light} alt="atmin" width={width} height={size} className="block dark:hidden"/>
    <img src={dark} alt="atmin" width={width} height={size} className="hidden dark:block"/>
  </>;
}

export function Brand() {
  return <span className="flex items-center gap-2.5 text-[15px] font-medium">
    <Mark size={24}/><span>atmin review</span>
  </span>;
}

export function Avatar({ src, name, size = 20 }) {
  const [failed, setFailed] = useState(false);
  if (failed || !src) {
    return <span aria-hidden="true" className="avatar avatar-fallback" data-size={size}>{name.slice(0, 1).toUpperCase()}</span>;
  }
  return <img src={src} alt="" width={size} height={size} className="avatar" data-size={size} onError={() => setFailed(true)}/>;
}
export const userAvatar = id => `https://avatars.githubusercontent.com/u/${id}?s=64`;
export const accountAvatar = login => `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=64`;

// Local loading indicator: only unfinished content spins, next to explicit text.
export function Loading({ children, className }) {
  return <p role="status" className={cn('flex items-center gap-2 text-[13px] text-muted-foreground', className)}>
    <ActivityMark state="running" light={false}/>{children}
  </p>;
}

export function Notice({ tone = 'info', children, action, className }) {
  const Icon = tone === 'error' ? CircleAlert : Info;
  return <div role={tone === 'error' ? 'alert' : 'status'} data-tone={tone} className={cn('notice', className)}>
    <Icon aria-hidden="true" className="notice-icon"/>
    <div className="min-w-0 flex-1">{children}</div>
    {action}
  </div>;
}

export function Figure({ children, className }) {
  return <span className={cn('figure', className)}>{children}</span>;
}

export function Progress({ value, max, label }) {
  return <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)}>
    <div className="progress-fill" style={{ width: `${share(value, max)}%` }}/>
  </div>;
}

export function RunState({ state }) {
  const known = runStates[state] ?? { label: state, mark: 'blocked' };
  return <span className="run-state"><ActivityMark state={known.mark} light={false}/><span>{known.label}</span></span>;
}

export function PageHeader({ title, children, actions }) {
  return <header className="page-header">
    <div className="min-w-0 flex-1">
      <h1>{title}</h1>
      {children && <p className="page-description">{children}</p>}
    </div>
    {actions && <div className="page-actions">{actions}</div>}
  </header>;
}

export function Field({ id, label, help, error, children }) {
  return <div className="field">
    <Label htmlFor={id}>{label}</Label>
    {children}
    {error ? <p id={`${id}-message`} className="error">{error}</p> : help && <p id={`${id}-message`}>{help}</p>}
  </div>;
}
