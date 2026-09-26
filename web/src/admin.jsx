import { Fragment, useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { api } from './api.js';
import { useResource } from './use-resource.js';
import { Badge } from './ui/badge.jsx';
import { Button } from './ui/button.jsx';
import { Card, CardContent, CardHeader } from './ui/card.jsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.jsx';
import { Input } from './ui/input.jsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.jsx';
import { AutoHeight } from './ui/auto-height.jsx';
import { Field, Figure, Loading, Notice, PageHeader, Progress } from './components.jsx';
import { count, usd } from './format.js';
import { planFields, validatePlan } from './validate.js';

const operatorOnly = 'Operator access is required.';
const accountKind = type => (type === 'User' ? 'Personal account' : 'Organization');
const planValue = (field, value) => (field.kind === 'usd' ? usd(value) : field.kind === 'multiplier' ? `${value}×` : count(value));

function Reviews({ usage, plan }) {
  return <><Figure>{count(usage.reviews)}</Figure> <span className="text-muted-foreground">/ {plan.monthlyReviews ? <Figure>{count(plan.monthlyReviews)}</Figure> : 'off'}</span></>;
}

function PlanSummary({ plan }) {
  return <div className="text-[13px]">
    <div><Figure>{count(plan.freeReviews)}</Figure> free · {plan.monthlyReviews ? <><Figure>{count(plan.monthlyReviews)}</Figure> limit</> : 'reviews off'}</div>
    <div className="text-muted-foreground"><Figure>{plan.multiplier}×</Figure> cost · <Figure>{usd(plan.minimumUsd)}</Figure> minimum</div>
  </div>;
}

function PlanDialog({ installation, defaults, onClose, onSaved }) {
  const prefix = useId();
  const [form, setForm] = useState(() => Object.fromEntries(planFields.map(f => [f.key, String(installation.plan[f.key])])));
  const [status, setStatus] = useState({ pending: false, submitted: false, error: null });
  const { errors, value } = validatePlan(form);
  const shown = status.submitted ? errors : {};

  async function submit(event) {
    event.preventDefault();
    const invalid = Object.keys(errors)[0];
    if (invalid) {
      setStatus({ pending: false, submitted: true, error: null });
      document.getElementById(`${prefix}-${invalid}`)?.focus();
      return;
    }
    setStatus({ pending: true, submitted: true, error: null });
    try {
      await api.savePlan(installation.id, value);
      onSaved();
    } catch (failure) {
      setStatus({ pending: false, submitted: true, error: failure.message });
    }
  }

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Edit plan for {installation.account}</DialogTitle>
        <DialogDescription>The monthly review limit is a hard cap. Set it to 0 to turn reviews off for this organization.</DialogDescription>
      </DialogHeader>
      <form id={`${prefix}-form`} noValidate onSubmit={submit}>
        {planFields.map(field => <Field key={field.key} id={`${prefix}-${field.key}`} label={field.label} error={shown[field.key]}
          help={<>Default: <Figure>{planValue(field, defaults[field.key])}</Figure></>}>
          <Input id={`${prefix}-${field.key}`} inputMode={field.kind === 'count' ? 'numeric' : 'decimal'} autoComplete="off"
            aria-invalid={shown[field.key] ? true : undefined} aria-describedby={`${prefix}-${field.key}-message`}
            value={form[field.key]} onChange={event => setForm(current => ({ ...current, [field.key]: event.target.value }))}/>
        </Field>)}
        {status.error && <Notice tone="error">{status.error}</Notice>}
      </form>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit" form={`${prefix}-form`} disabled={status.pending}>{status.pending ? 'Saving…' : 'Save plan'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function Customers({ data, onEdit }) {
  const [open, setOpen] = useState(() => new Set());
  const toggle = id => setOpen(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return <Card className="panel">
    <CardHeader className="panel-toolbar border-b">
      <h2 className="panel-title">Organizations</h2>
      <p className="text-[13px] text-muted-foreground">Reviews and cost are for this month. Recorded cost runs below the provider’s bill; billing figures are estimates.</p>
    </CardHeader>
    <AutoHeight>
      <Table className="panel-table">
        <TableHeader>
          <TableRow>
            <TableHead className="w-10"><span className="sr-only">Repositories</span></TableHead>
            <TableHead>Account</TableHead>
            <TableHead className="text-right max-md:hidden">Repositories</TableHead>
            <TableHead className="text-right max-md:hidden">Reviews</TableHead>
            <TableHead className="text-right max-md:hidden">Recorded cost</TableHead>
            <TableHead className="text-right">Estimated billing</TableHead>
            <TableHead className="max-md:hidden">Plan</TableHead>
            <TableHead className="max-md:hidden"><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.installations.map(installation => {
            const expanded = open.has(installation.id);
            const { plan, usage, repositories } = installation;
            return <Fragment key={installation.id}>
              <TableRow>
                <TableCell>
                  <Button variant="ghost" size="icon-sm" aria-expanded={expanded} aria-controls={`repositories-${installation.id}`}
                    aria-label={`${expanded ? 'Hide' : 'Show'} repositories for ${installation.account}`} onClick={() => toggle(installation.id)}>
                    <ChevronRight aria-hidden="true" className={expanded ? 'rotate-90' : ''}/>
                  </Button>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium">{installation.account}</span>
                    {installation.removed && <Badge variant="outline">Removed</Badge>}
                    {installation.suspended && <Badge variant="outline">Suspended</Badge>}
                  </div>
                  <div className="text-[13px] text-muted-foreground">{accountKind(installation.accountType)}</div>
                  <div className="text-[13px] md:hidden"><Reviews usage={usage} plan={plan}/> reviews</div>
                  <Button variant="outline" size="sm" className="mt-2 md:hidden" onClick={() => onEdit(installation)}>Edit plan</Button>
                </TableCell>
                <TableCell className="text-right max-md:hidden"><Figure>{repositories.length}</Figure></TableCell>
                <TableCell className="text-right max-md:hidden"><Reviews usage={usage} plan={plan}/></TableCell>
                <TableCell className="text-right max-md:hidden"><Figure>{usd(usage.knownUsd)}</Figure></TableCell>
                <TableCell className="text-right">
                  <Figure>{usd(usage.estimatedUsd)}</Figure>
                  {usage.unknownCostReviews > 0 && <div className="text-[13px] text-muted-foreground">{usage.unknownCostReviews} unsettled</div>}
                </TableCell>
                <TableCell className="max-md:hidden">
                  <PlanSummary plan={plan}/>
                  {plan.custom && <div className="text-[13px] text-muted-foreground">Custom{plan.updatedBy ? ` · set by ${plan.updatedBy}` : ''}</div>}
                </TableCell>
                <TableCell className="text-right max-md:hidden"><Button variant="outline" size="sm" onClick={() => onEdit(installation)}>Edit plan</Button></TableCell>
              </TableRow>
              {expanded && <TableRow id={`repositories-${installation.id}`} className="hover:bg-transparent">
                <TableCell colSpan={8} className="bg-muted/40 py-3 whitespace-normal">
                  {repositories.length
                    ? <ul className="admin-repositories">
                      {repositories.map(repository => <li key={repository.id}>
                        <span className="min-w-0 break-all">{repository.name}</span>
                        <span className="status">{repository.enabled ? 'On' : 'Paused'}</span>
                        <span className="text-right"><Figure>{count(repository.reviews)}</Figure> <span className="text-muted-foreground">{repository.reviews === 1 ? 'review' : 'reviews'}</span></span>
                      </li>)}
                    </ul>
                    : <p className="text-muted-foreground">No connected repositories.</p>}
                </TableCell>
              </TableRow>}
            </Fragment>;
          })}
          {!data.installations.length && <TableRow><TableCell colSpan={8} className="empty-cell">No organization has installed atmin review.</TableCell></TableRow>}
        </TableBody>
      </Table>
    </AutoHeight>
  </Card>;
}

function Operator() {
  const admin = useResource('admin', () => api.admin());
  const [editing, setEditing] = useState(null);
  const data = admin.data;
  const error = admin.error && (admin.error.status === 403 ? operatorOnly : admin.error.message);
  return <>
    <PageHeader title="Admin">Plans, usage and recorded cost for each organization that installed atmin review.</PageHeader>
    <div className="grid grid-cols-1 gap-4">
      {error && <Notice tone="error">{error}</Notice>}
      {!data && admin.loading && <Loading>Loading organizations</Loading>}
      {data && <>
        <Card className="max-w-[560px]">
          <CardHeader><h2 className="panel-title">Reviews in the last 24 hours</h2></CardHeader>
          <CardContent className="grid gap-3">
            <p className="flex items-baseline gap-2">
              <Figure className="text-[28px] leading-none">{count(data.limits.reviewsToday)}</Figure>
              <span className="text-muted-foreground">of <Figure>{count(data.limits.maxReviewsPerDay)}</Figure></span>
            </p>
            <Progress value={data.limits.reviewsToday} max={data.limits.maxReviewsPerDay} label="Reviews started in the last 24 hours"/>
            <p className="text-[13px] text-muted-foreground">The global backstop counts reviews started in the last 24 hours across every organization.</p>
          </CardContent>
        </Card>
        <Customers data={data} onEdit={setEditing}/>
      </>}
    </div>
    {editing && data && <PlanDialog installation={editing} defaults={data.defaults} onClose={() => setEditing(null)}
      onSaved={() => { setEditing(null); admin.reload(); }}/>}
  </>;
}

export function AdminPage({ operator }) {
  if (!operator) return <><PageHeader title="Admin"/><Notice tone="error">{operatorOnly}</Notice></>;
  return <Operator/>;
}
