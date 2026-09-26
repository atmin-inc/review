import { useContext, useId, useState } from 'react';
import {
  ArrowLeft, ChevronDown, CircleHelp, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, RefreshCw,
} from 'lucide-react';
import { api } from './api.js';
import { useResource } from './use-resource.js';
import { Button } from './ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader } from './ui/card.jsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './ui/dropdown-menu.jsx';
import { Input } from './ui/input.jsx';
import { Switch } from './ui/switch.jsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.jsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs.jsx';
import { AutoHeight } from './ui/auto-height.jsx';
import { ActivityMark } from './ui/activity.jsx';
import { ExternalLink, Field, Figure, Link, Loading, Navigation, Notice, RunState } from './components.jsx';
import { ReviewPanel } from './review.jsx';
import { dateTime, runCost, usd } from './format.js';
import { routeHref } from './route.js';
import { validateSettings } from './validate.js';

const priorities = ['P0', 'P1', 'P2', 'P3', 'P4'];
const pullStates = {
  open: ['Open', GitPullRequest], draft: ['Draft', GitPullRequestDraft], merged: ['Merged', GitMerge],
  closed: ['Closed', GitPullRequestClosed], unknown: ['Unknown', CircleHelp],
};

const reviewHref = (repository, run) => routeHref({ view: 'repository', repository, review: run });
const modelLabel = (models, usage) => (usage ? models.find(m => m.model === usage.model)?.label ?? usage.model : '—');

function PullState({ state }) {
  const [label, Icon] = pullStates[state] ?? pullStates.unknown;
  return <span className="inline-flex items-center gap-1.5"><Icon aria-hidden="true" className="size-4 text-muted-foreground"/>{label}</span>;
}

function PullsTable({ id, data }) {
  return <>
    <Card className="panel">
      <Table className="panel-table">
        <TableHeader>
          <TableRow>
            <TableHead>Pull request</TableHead>
            <TableHead className="max-md:hidden">Author</TableHead>
            <TableHead className="max-md:hidden">State</TableHead>
            <TableHead>Latest review</TableHead>
            {priorities.map(p => <TableHead key={p} className="text-right max-md:hidden">{p}</TableHead>)}
            <TableHead className="text-right max-md:hidden">Coverage</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.pulls.map(pull => <TableRow key={pull.pr}>
            <TableCell className="whitespace-normal md:min-w-[240px]">
              <ExternalLink href={pull.url} icon={false}><Figure className="text-muted-foreground">#{pull.pr}</Figure> {pull.title}</ExternalLink>
              <div className="mt-0.5 text-[13px] text-muted-foreground md:hidden">{pull.author ?? 'Unknown author'} · {(pullStates[pull.state] ?? pullStates.unknown)[0]}</div>
            </TableCell>
            <TableCell className="max-md:hidden">{pull.author ?? <span className="text-muted-foreground">Unknown</span>}</TableCell>
            <TableCell className="max-md:hidden"><PullState state={pull.state}/></TableCell>
            <TableCell>
              {pull.run
                ? <Link className="link" href={reviewHref(id, pull.run.id)}>{pull.run.verdict ?? <RunState state={pull.run.state}/>}</Link>
                : <span className="text-muted-foreground">Not reviewed</span>}
            </TableCell>
            {priorities.map(p => <TableCell key={p} className="text-right max-md:hidden">
              {pull.counts ? <Figure className={pull.counts[p] ? '' : 'text-muted-foreground'}>{pull.counts[p]}</Figure> : <span className="text-muted-foreground">—</span>}
            </TableCell>)}
            <TableCell className="text-right max-md:hidden">
              {pull.coverage ? <Figure>{pull.coverage.reviewed}/{pull.coverage.total}</Figure> : <span className="text-muted-foreground">—</span>}
            </TableCell>
          </TableRow>)}
          {!data.pulls.length && <TableRow><TableCell colSpan={10} className="empty-cell">No pull requests were found in this repository.</TableCell></TableRow>}
        </TableBody>
      </Table>
    </Card>
    {data.pulls.length >= data.pullLimit && <p className="mt-3 text-[13px] text-muted-foreground">
      Showing the {data.pullLimit} most recently updated pull requests.
    </p>}
  </>;
}

function RunsTable({ id, data }) {
  return <Card className="panel">
    <Table className="panel-table">
      <TableHeader>
        <TableRow>
          <TableHead>Started</TableHead>
          <TableHead className="max-md:hidden">Pull request</TableHead>
          <TableHead>State</TableHead>
          <TableHead className="max-md:hidden">Verdict</TableHead>
          <TableHead className="max-md:hidden">Model</TableHead>
          <TableHead className="text-right max-md:hidden">Cost</TableHead>
          <TableHead className="max-md:hidden"><span className="sr-only">Review</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.runs.map(run => <TableRow key={run.id}>
          <TableCell>
            <Link className="link" href={reviewHref(id, run.id)}><Figure className="text-[13px]">{dateTime(run.createdAt)}</Figure></Link>
            <div className="text-[13px] text-muted-foreground md:hidden">
              <Figure>#{run.pr}</Figure>{run.verdict ? ` · ${run.verdict}` : ''} · {run.usage?.totalUsd != null ? <Figure>{runCost(run)}</Figure> : runCost(run)}
            </div>
          </TableCell>
          <TableCell className="max-md:hidden"><ExternalLink href={run.url} icon={false}><Figure>#{run.pr}</Figure></ExternalLink></TableCell>
          <TableCell><RunState state={run.state}/></TableCell>
          <TableCell className="max-md:hidden">{run.verdict ?? <span className="text-muted-foreground">—</span>}</TableCell>
          <TableCell className="max-md:hidden">{modelLabel(data.models, run.usage)}</TableCell>
          <TableCell className="text-right max-md:hidden">
            {run.usage?.totalUsd != null ? <Figure>{runCost(run)}</Figure> : <span className="text-muted-foreground">{runCost(run)}</span>}
          </TableCell>
          <TableCell className="text-right max-md:hidden">
            <Button asChild variant="ghost" size="sm"><Link href={reviewHref(id, run.id)} aria-label={`View review of #${run.pr} started ${dateTime(run.createdAt)}`}>View</Link></Button>
          </TableCell>
        </TableRow>)}
        {!data.runs.length && <TableRow><TableCell colSpan={7} className="empty-cell">No reviews have run in this repository yet.</TableCell></TableRow>}
      </TableBody>
    </Table>
  </Card>;
}

function SettingsForm({ id, data, onSaved }) {
  const prefix = useId();
  const [form, setForm] = useState(() => ({
    model: data.settings.model, maxUsd: String(data.settings.maxUsd), maxReviewsPerDay: String(data.settings.maxReviewsPerDay),
  }));
  const [status, setStatus] = useState({ pending: false, submitted: false, error: null, saved: false });
  const { errors, value } = validateSettings(form, data.models, data.limits);
  const shown = status.submitted ? errors : {};
  const model = data.models.find(m => m.id === form.model);
  const changed = value.model !== data.settings.model || value.maxUsd !== data.settings.maxUsd || value.maxReviewsPerDay !== data.settings.maxReviewsPerDay;
  const edit = (key, next) => { setForm(current => ({ ...current, [key]: next })); setStatus(current => ({ ...current, saved: false, error: null })); };

  async function submit(event) {
    event.preventDefault();
    const invalid = Object.keys(errors)[0];
    if (invalid) {
      setStatus({ pending: false, submitted: true, error: null, saved: false });
      document.getElementById(`${prefix}-${invalid}`)?.focus();
      return;
    }
    setStatus({ pending: true, submitted: true, error: null, saved: false });
    try {
      const result = await api.saveSettings(id, value);
      onSaved(result.settings);
      setStatus({ pending: false, submitted: false, error: null, saved: true });
    } catch (failure) {
      setStatus({ pending: false, submitted: true, error: failure.message, saved: false });
    }
  }

  const describe = key => ({ id: `${prefix}-${key}`, 'aria-invalid': shown[key] ? true : undefined, 'aria-describedby': `${prefix}-${key}-message` });
  return <Card className="max-w-[560px]">
    <CardHeader>
      <h2 className="panel-title">Review settings</h2>
      <CardDescription>Applies to reviews that start after you save.</CardDescription>
    </CardHeader>
    <CardContent>
      <form noValidate onSubmit={submit}>
        <Field id={`${prefix}-model`} label="Model" error={shown.model}
          help={model ? <>Up to <Figure>{usd(model.maxUsd)}</Figure> per review with {model.label}.</> : 'Choose a model.'}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="w-full justify-between" {...describe('model')}>
                {model?.label ?? 'Choose a model'}<ChevronDown aria-hidden="true"/>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup value={form.model} onValueChange={next => edit('model', next)}>
                {data.models.map(m => <DropdownMenuRadioItem key={m.id} value={m.id}>
                  <span className="flex-1">{m.label}</span>
                  <span className="text-xs text-muted-foreground">up to <Figure>{usd(m.maxUsd)}</Figure></span>
                </DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </Field>
        <Field id={`${prefix}-maxUsd`} label="Maximum spend per review (USD)" error={shown.maxUsd}
          help={model ? <>From <Figure>{usd(0)}</Figure> to <Figure>{usd(model.maxUsd)}</Figure>.</> : undefined}>
          <Input {...describe('maxUsd')} inputMode="decimal" autoComplete="off" value={form.maxUsd} onChange={event => edit('maxUsd', event.target.value)}/>
        </Field>
        <Field id={`${prefix}-maxReviewsPerDay`} label="Maximum reviews per day" error={shown.maxReviewsPerDay}
          help={<>From <Figure>1</Figure> to <Figure>{data.limits.maxReviewsPerDay}</Figure>.</>}>
          <Input {...describe('maxReviewsPerDay')} inputMode="numeric" autoComplete="off" value={form.maxReviewsPerDay} onChange={event => edit('maxReviewsPerDay', event.target.value)}/>
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={status.pending || !changed}>{status.pending ? 'Saving…' : 'Save settings'}</Button>
          <p role="status" className="text-[13px] text-muted-foreground">{status.saved ? 'Saved.' : ''}</p>
        </div>
        {status.error && <Notice tone="error" className="mt-4">{status.error}</Notice>}
      </form>
    </CardContent>
  </Card>;
}

export function RepositoryPage({ id, review, listed, installation, initial, patchRepository }) {
  const navigate = useContext(Navigation);
  const dashboard = useResource(`dashboard:${id}`, () => api.dashboard(id), initial);
  const [toggle, setToggle] = useState({ pending: false, error: null });
  const data = dashboard.data;
  const name = data?.repository.name ?? listed?.name ?? `Repository ${id}`;
  const enabled = data?.repository.enabled ?? listed?.enabled;
  const back = routeHref({ view: 'repositories', installation: data?.repository.installationId ?? listed?.installationId ?? installation.id });

  async function setEnabled(on) {
    setToggle({ pending: true, error: null });
    try {
      const result = await api.setEnabled(id, on);
      dashboard.update(current => current && ({ ...current, repository: { ...current.repository, enabled: result.enabled } }));
      patchRepository(id, { enabled: result.enabled });
      setToggle({ pending: false, error: null });
    } catch (failure) {
      setToggle({ pending: false, error: failure.message });
    }
  }

  return <>
    <header className="page-header">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Button asChild variant="ghost" size="icon"><Link href={back} aria-label="Back to repositories"><ArrowLeft aria-hidden="true"/></Link></Button>
        <h1 className="min-w-0 break-words">{name}</h1>
      </div>
      <div className="page-actions">
        {(data || listed?.connected) && <label className="flex items-center gap-2 text-sm">
          <Switch checked={enabled === true} disabled={toggle.pending} onCheckedChange={setEnabled}/>
          Reviews {enabled ? 'on' : 'paused'}
        </label>}
        <Button asChild variant="outline"><a href={`https://github.com/${name}`} target="_blank" rel="noreferrer">View on GitHub</a></Button>
      </div>
    </header>
    <AutoHeight>
      <div className="grid grid-cols-1 gap-4">
        {toggle.error && <Notice tone="error">{toggle.error}</Notice>}
        {dashboard.error && <Notice tone="error" action={!data && <Link className="link whitespace-nowrap" href={back}>Back to repositories</Link>}>{dashboard.error.message}</Notice>}
        {!data && dashboard.loading && <Loading>Loading pull requests and runs</Loading>}
        {data && <Tabs defaultValue="pulls" className="gap-4">
          <div className="tabs-bar">
            <TabsList>
              <TabsTrigger value="pulls">Pull requests <Figure className="text-muted-foreground">{data.pulls.length}</Figure></TabsTrigger>
              <TabsTrigger value="runs">Recent runs</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <span role="status" className="flex items-center gap-2">
                {dashboard.loading ? <><ActivityMark state="running" light={false}/>Refreshing</> : `Checked ${dateTime(data.checkedAt)}`}
              </span>
              <Button variant="ghost" size="sm" onClick={dashboard.reload} disabled={dashboard.loading}><RefreshCw aria-hidden="true"/>Refresh</Button>
            </div>
          </div>
          <TabsContent value="pulls"><PullsTable id={id} data={data}/></TabsContent>
          <TabsContent value="runs"><RunsTable id={id} data={data}/></TabsContent>
          <TabsContent value="settings">
            <SettingsForm id={id} data={data}
              onSaved={settings => dashboard.update(current => ({ ...current, settings }))}/>
          </TabsContent>
        </Tabs>}
      </div>
    </AutoHeight>
    {review && <ReviewPanel repository={id} name={name} run={review} models={data?.models ?? []}
      onClose={() => navigate(routeHref({ view: 'repository', repository: id }))}/>}
  </>;
}
