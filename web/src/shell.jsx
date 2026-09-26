import { useContext, useEffect, useState } from 'react';
import { ChevronsUpDown, FolderGit2, Gauge, LogOut, Menu, Plus, Shield } from 'lucide-react';
import { Button } from './ui/button.jsx';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.jsx';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from './ui/dropdown-menu.jsx';
import { Avatar, Brand, Link, Navigation, accountAvatar, userAvatar } from './components.jsx';
import { routeHref } from './route.js';
import { cn } from './lib/utils.js';

const accountKind = type => (type === 'User' ? 'Personal account' : 'Organization');

function OrganizationSwitcher({ installations, selected, installUrl, route }) {
  const navigate = useContext(Navigation);
  const choose = id => navigate(routeHref({ view: route.view === 'usage' ? 'usage' : 'repositories', installation: Number(id) }));
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="outline" className="w-full justify-between" aria-label={`Organization: ${selected.account}. Switch organization`}>
        <span className="flex min-w-0 items-center gap-2">
          <Avatar src={accountAvatar(selected.account)} name={selected.account}/>
          <span className="truncate">{selected.account}</span>
        </span>
        <ChevronsUpDown aria-hidden="true"/>
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start">
      <DropdownMenuRadioGroup value={String(selected.id)} onValueChange={choose}>
        {installations.map(installation => <DropdownMenuRadioItem key={installation.id} value={String(installation.id)}>
          <Avatar src={accountAvatar(installation.account)} name={installation.account}/>
          <span className="grid min-w-0">
            <span className="truncate">{installation.account}</span>
            <span className="text-xs text-muted-foreground">{accountKind(installation.accountType)}</span>
          </span>
        </DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
      {installUrl && <>
        <DropdownMenuSeparator/>
        <DropdownMenuItem asChild><a href={installUrl}><Plus aria-hidden="true"/>Add an organization</a></DropdownMenuItem>
      </>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

function Sidebar({ session, installation, route, onSignOut }) {
  const { installations, installUrl } = session.connections;
  const links = [
    { href: routeHref({ view: 'repositories', installation: installation.id }), label: 'Repositories', icon: FolderGit2, active: route.view === 'repositories' || route.view === 'repository' },
    { href: routeHref({ view: 'usage', installation: installation.id }), label: 'Usage', icon: Gauge, active: route.view === 'usage' },
    ...(session.operator ? [{ href: '/admin', label: 'Admin', icon: Shield, active: route.view === 'admin' }] : []),
  ];
  return <div className="sidebar-content">
    <div className="px-2 py-1"><Brand/></div>
    <OrganizationSwitcher installations={installations} selected={installation} installUrl={installUrl} route={route}/>
    <nav aria-label="Main">
      <ul className="grid gap-0.5">
        {links.map(({ href, label, icon: Icon, active }) => <li key={label}>
          <Button asChild variant="ghost" className={cn('w-full justify-start', active ? 'bg-accent text-foreground' : 'text-muted-foreground')}>
            <Link href={href} aria-current={active ? 'page' : undefined}><Icon aria-hidden="true"/>{label}</Link>
          </Button>
        </li>)}
      </ul>
    </nav>
    <div className="sidebar-user">
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <Avatar src={userAvatar(session.user.id)} name={session.user.login}/>
        <span className="truncate">{session.user.login}</span>
      </span>
      <Button variant="ghost" size="sm" onClick={onSignOut}><LogOut aria-hidden="true"/>Sign out</Button>
    </div>
  </div>;
}

export function Shell({ session, installation, route, onSignOut, children }) {
  const [open, setOpen] = useState(false);
  const place = `${route.view}:${route.repository ?? ''}:${route.installation ?? ''}`;
  useEffect(() => setOpen(false), [place]);
  const sidebar = <Sidebar session={session} installation={installation} route={route} onSignOut={onSignOut}/>;
  return <div className="app-shell">
    <aside className="sidebar">{sidebar}</aside>
    <header className="topbar">
      <Button variant="ghost" size="icon" aria-label="Open navigation" onClick={() => setOpen(true)}><Menu aria-hidden="true"/></Button>
      <Brand/>
      <span className="ml-auto truncate pr-2 text-sm text-muted-foreground">{installation.account}</span>
    </header>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="nav-drawer" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Navigation</DialogTitle>
        {sidebar}
      </DialogContent>
    </Dialog>
    <main className="main">{children}</main>
  </div>;
}
