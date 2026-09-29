import { useState } from 'react';
import { Search } from 'lucide-react';
import { api } from './api.js';
import { Button } from './ui/button.jsx';
import { Card, CardHeader } from './ui/card.jsx';
import { Input } from './ui/input.jsx';
import { Switch } from './ui/switch.jsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.jsx';
import { ExternalLink, Figure, Link, Notice, PageHeader } from './components.jsx';
import { UsageNotice } from './usage.jsx';
import { routeHref } from './route.js';

function Status({ repository }) {
  if (!repository.connected) return <span className="text-[13px] text-muted-foreground">Not connected</span>;
  return <span className="status">Connected · {repository.enabled ? 'on' : 'paused'}</span>;
}

export function RepositoriesPage({ installation, connections, patchRepository }) {
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const all = connections.repositories.filter(r => r.installationId === installation.id)
    .toSorted((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
  const connected = all.filter(r => r.connected).length;
  const max = connections.maxRepositories;
  const full = connected >= max;
  const needle = query.trim().toLowerCase();
  const shown = needle ? all.filter(r => r.name.toLowerCase().includes(needle)) : all;

  async function change(repository, action) {
    setPending(repository.id);
    setError(null);
    try {
      if (action === 'connect') {
        const result = await api.connect(repository.id);
        patchRepository(repository.id, { connected: true, enabled: result.repository.enabled });
      } else {
        const result = await api.setEnabled(repository.id, action === 'on');
        patchRepository(repository.id, { enabled: result.enabled });
      }
    } catch (failure) {
      setError(`${repository.name}: ${failure.message}`);
    } finally {
      setPending(null);
    }
  }

  return <>
    <PageHeader title="Repositories">
      Connect up to {max} repositories in {installation.account}. atmin reviews pull requests in a connected repository while its reviews are on.
    </PageHeader>
    <div className="grid grid-cols-1 gap-4">
      <UsageNotice installation={installation} link/>
      {error && <Notice tone="error">{error}</Notice>}
      <Card className="panel">
        <CardHeader className="panel-toolbar border-b">
          <p className="text-sm"><Figure>{connected}</Figure> of <Figure>{max}</Figure> connected</p>
          <div className="search-field">
            <Search aria-hidden="true"/>
            <Input type="search" aria-label="Search repositories" placeholder="Search repositories" value={query} onChange={event => setQuery(event.target.value)}/>
          </div>
          <ExternalLink href={installation.manageUrl} className="text-sm">Choose repositories on GitHub</ExternalLink>
        </CardHeader>
        <Table className="panel-table">
          <TableHeader>
            <TableRow>
              <TableHead>Repository</TableHead>
              <TableHead className="max-md:hidden">Status</TableHead>
              <TableHead>Reviews</TableHead>
              <TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map(repository => {
              const busy = pending === repository.id;
              return <TableRow key={repository.id}>
                <TableCell className="font-medium max-md:whitespace-normal max-md:break-all">
                  {repository.connected
                    ? <Link className="link" href={routeHref({ view: 'repository', repository: repository.id })}>{repository.name}</Link>
                    : repository.name}
                  <div className="mt-0.5 font-normal md:hidden"><Status repository={repository}/></div>
                </TableCell>
                <TableCell className="max-md:hidden"><Status repository={repository}/></TableCell>
                <TableCell>
                  {repository.connected && <Switch checked={repository.enabled === true} disabled={busy}
                    aria-label={`Reviews for ${repository.name}`} onCheckedChange={on => change(repository, on ? 'on' : 'off')}/>}
                </TableCell>
                <TableCell className="text-right">
                  {repository.connected
                    ? <Button asChild variant="ghost" size="sm"><Link href={routeHref({ view: 'repository', repository: repository.id })} aria-label={`Open ${repository.name}`}>Open</Link></Button>
                    : <Button variant="outline" size="sm" disabled={busy || full} title={full ? `${installation.account} has ${max} connected repositories, the limit.` : undefined}
                      onClick={() => change(repository, 'connect')}>{busy ? 'Connecting…' : 'Connect'}</Button>}
                </TableCell>
              </TableRow>;
            })}
            {!all.length && <TableRow><TableCell colSpan={4} className="empty-cell">
              atmin review cannot see any repositories in {installation.account}. <ExternalLink href={installation.manageUrl}>Choose repositories on GitHub</ExternalLink> to give it access.
            </TableCell></TableRow>}
            {all.length > 0 && !shown.length && <TableRow><TableCell colSpan={4} className="empty-cell">
              <span className="flex flex-wrap items-center gap-3">
                No repositories match “{query.trim()}”.
                <Button variant="outline" size="sm" onClick={() => setQuery('')}>Clear search</Button>
              </span>
            </TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>
      {full && <p className="text-[13px] text-muted-foreground">
        {installation.account} has {max} connected repositories, the limit for one organization.
      </p>}
    </div>
  </>;
}
