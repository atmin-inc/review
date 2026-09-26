import { useState } from 'react';
import { api } from './api.js';
import { useResource } from './use-resource.js';
import { Button } from './ui/button.jsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog.jsx';
import { AutoHeight } from './ui/auto-height.jsx';
import { ExternalLink, Figure, Link, Loading, Notice, RunState } from './components.jsx';
import { dateTime, plural, runCost } from './format.js';
import { routeHref } from './route.js';

const priorities = ['P0', 'P1', 'P2', 'P3', 'P4'];
const evidenceKinds = { 'source-read': 'Source read', 'source-reasoning': 'Source reasoning', reproduction: 'Reproduction', ci: 'CI' };
const coverageLimit = 20;

function Finding({ finding }) {
  return <article className="finding">
    <div className="grid gap-1">
      <h5>{finding.title}</h5>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
        <ExternalLink href={finding.url}><span className="figure break-all">{finding.anchor.path}:{finding.anchor.line}</span></ExternalLink>
        <span>{finding.category} · {finding.kind}</span>
      </p>
    </div>
    <dl className="finding-details">
      <div><dt>Trigger</dt><dd>{finding.trigger}</dd></div>
      <div><dt>Consequence</dt><dd>{finding.consequence}</dd></div>
      {finding.suggestion && <div><dt>Suggestion</dt><dd>{finding.suggestion}</dd></div>}
      {finding.evidence?.length > 0 && <div><dt>Evidence</dt><dd>
        <ul className="grid gap-1.5">
          {finding.evidence.map(item => <li key={item.id}><span className="text-muted-foreground">{evidenceKinds[item.kind] ?? item.kind}:</span> {item.summary}</li>)}
        </ul>
      </dd></div>}
    </dl>
  </article>;
}

function Coverage({ coverage }) {
  const [all, setAll] = useState(false);
  const reviewed = coverage.filter(c => c.status === 'reviewed').length;
  const shown = all ? coverage : coverage.slice(0, coverageLimit);
  return <section className="review-section">
    <h3>Coverage</h3>
    <p className="text-muted-foreground"><Figure>{reviewed}</Figure> of {plural(coverage.length, 'changed file')} reviewed.</p>
    {coverage.length > 0 && <ul className="coverage">
      {shown.map(item => <li key={item.path}>
        <span className="figure min-w-0 break-all">{item.path}</span>
        <span className={item.status === 'reviewed' ? '' : 'text-muted-foreground'}>{item.status === 'reviewed' ? 'Reviewed' : 'Not reviewed'}</span>
      </li>)}
    </ul>}
    {coverage.length > coverageLimit && !all && <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setAll(true)}>
      Show all {coverage.length} files
    </Button>}
  </section>;
}

function Report({ repository, detail, models }) {
  const { run, report, reason, runs } = detail;
  const findings = report?.assessment.findings ?? [];
  const model = run.usage ? models.find(m => m.model === run.usage.model)?.label ?? run.usage.model : null;
  return <div className="grid gap-6">
    <dl className="facts">
      <div><dt>Outcome</dt><dd>{report?.assessment.outcome ?? run.verdict ?? 'No verdict'}</dd></div>
      <div><dt>State</dt><dd><RunState state={run.state}/></dd></div>
      <div><dt>Started</dt><dd><Figure>{dateTime(run.createdAt)}</Figure></dd></div>
      <div><dt>Model</dt><dd>{model ?? '—'}</dd></div>
      <div><dt>Cost</dt><dd>{run.usage?.totalUsd != null ? <Figure>{runCost(run)}</Figure> : runCost(run)}</dd></div>
      {(report?.head ?? run.head) && <div><dt>Commit</dt><dd><Figure>{(report?.head ?? run.head).slice(0, 12)}</Figure></dd></div>}
    </dl>
    {reason && <Notice>{reason}</Notice>}
    {report && <section className="review-section">
      <h3>Summary</h3>
      <p>{report.summary}</p>
    </section>}
    {report && <section className="review-section">
      <h3>Findings</h3>
      {!findings.length && <p className="text-muted-foreground">No findings were recorded in this review.</p>}
      {priorities.map(priority => {
        const group = findings.filter(f => f.priority === priority);
        if (!group.length) return null;
        return <section key={priority} className="finding-group">
          <h4><Figure>{priority}</Figure> <span className="text-muted-foreground">· {plural(group.length, 'finding')}</span></h4>
          {group.map(finding => <Finding key={finding.id} finding={finding}/>)}
        </section>;
      })}
    </section>}
    {report && <Coverage coverage={report.coverage}/>}
    {report?.limitations.length > 0 && <section className="review-section">
      <h3>Limitations</h3>
      <ul className="list-disc grid gap-1.5 pl-5">{report.limitations.map(text => <li key={text}>{text}</li>)}</ul>
    </section>}
    {runs?.length > 1 && <section className="review-section">
      <h3>Runs of this pull request</h3>
      <ul className="other-runs">
        {runs.map(other => <li key={other.id}>
          <Figure className="text-[13px]">{dateTime(other.createdAt)}</Figure>
          <RunState state={other.state}/>
          <span className="text-muted-foreground">{other.verdict ?? ''}</span>
          {other.id === run.id
            ? <span className="text-[13px] text-muted-foreground">Viewing</span>
            : <Link className="link text-[13px]" href={routeHref({ view: 'repository', repository, review: other.id })}>View</Link>}
        </li>)}
      </ul>
    </section>}
  </div>;
}

export function ReviewPanel({ repository, name, run, models, onClose }) {
  const detail = useResource(`review:${repository}:${run}`, () => api.review(repository, run));
  const data = detail.data;
  const pr = data?.run.pr;
  const title = data ? (data.pull?.title ? `#${pr} ${data.pull.title}` : `Pull request #${pr}`) : 'Review';
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="review-panel">
      <DialogHeader className="review-header">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {name} · review <span className="figure">{run}</span>
          {data && <> · <ExternalLink href={data.run.url}>Open on GitHub</ExternalLink></>}
        </DialogDescription>
      </DialogHeader>
      <div className="review-body">
        <AutoHeight>
          {detail.error && <Notice tone="error">{detail.error.message}</Notice>}
          {!data && detail.loading && <Loading>Loading the review</Loading>}
          {data && <Report repository={repository} detail={data} models={models}/>}
        </AutoHeight>
      </div>
    </DialogContent>
  </Dialog>;
}
