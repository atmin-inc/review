import { useEffect, useRef, useState } from 'react';
import { CreditCard } from 'lucide-react';
import { api } from './api.js';
import { Badge } from './ui/badge.jsx';
import { Button } from './ui/button.jsx';
import { Card, CardAction, CardContent, CardHeader } from './ui/card.jsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.jsx';
import { Figure, Notice, PageHeader, Progress } from './components.jsx';
import { count, money, monthName, plural, usd, utcDate } from './format.js';
import { routeHref } from './route.js';
import { UsageNotice } from './usage.jsx';

// Invoices go out on the 2nd of each month, for the month before.
const nextInvoice = usage => new Date(Date.parse(usage.resetsAt) + 86_400_000).toISOString();

const invoiceStates = {
  finalized: { label: 'Charging card', variant: 'outline' },
  failed: { label: 'Payment failed', variant: 'destructive' },
  paid: { label: 'Paid', variant: 'outline' },
  uncollectible: { label: 'Not paid', variant: 'destructive' },
  void: { label: 'Cancelled', variant: 'secondary' },
  'nothing-due': { label: 'Nothing due', variant: 'secondary' },
};

function price(plan) {
  const multiplier = `model cost × ${plan.multiplier}`;
  return plan.minimumUsd > 0 ? `${multiplier}, at least ${money(plan.minimumUsd)}` : multiplier;
}

function PlanCard({ installation }) {
  const { plan, billing } = installation;
  const name = plan.custom ? 'Custom plan' : billing.unpaid ? 'Paused' : billing.card ? 'Pay as you go' : 'Free';
  return <Card>
    <CardHeader>
      <h2 className="panel-title">Plan</h2>
      <CardAction><Badge variant="secondary">{name}</Badge></CardAction>
    </CardHeader>
    <CardContent className="grid gap-4">
      <dl className="facts">
        <div><dt>Free reviews</dt><dd><Figure>{count(plan.freeReviews)}</Figure> a month</dd></div>
        <div><dt>Each review after that</dt><dd>{billing.unpaid && billing.needsCard ? 'Paused until the invoice is paid' : billing.needsCard ? 'Needs a card' : price(plan)}</dd></div>
        <div><dt>Review limit</dt><dd>{plan.monthlyReviews ? <><Figure>{count(plan.monthlyReviews)}</Figure> a month</> : 'Reviews off'}</dd></div>
      </dl>
      <p className="text-[13px] text-muted-foreground">
        {plan.custom ? 'Set by atmin for this organization. ' : ''}Each PR comment shows what its review cost.
      </p>
    </CardContent>
  </Card>;
}

// This month's charges, and the ceiling a card that has not paid much yet can reach.
function MonthCard({ installation }) {
  const { usage, billing, account } = installation, { spending } = billing;
  const ceiling = billing.card && !billing.needsCard ? spending.monthlyUsd : null;
  return <Card>
    <CardHeader><h2 className="panel-title">{monthName(usage.month)}</h2></CardHeader>
    <CardContent className="grid gap-4">
      <p className="flex items-baseline gap-2">
        <Figure className="text-[28px] leading-none">{usd(usage.estimatedUsd)}</Figure>
        <span className="text-muted-foreground">{ceiling === null ? 'so far' : <>of <Figure>{money(ceiling)}</Figure> limit</>}</span>
      </p>
      {ceiling !== null && <Progress value={usage.estimatedUsd} max={ceiling} label={`${usd(usage.estimatedUsd)} of the ${money(ceiling)} monthly spending limit`}/>}
      <dl className="facts">
        <div><dt>Reviews</dt><dd><Figure>{count(usage.reviews)}</Figure></dd></div>
        {billing.card && <div><dt>Next invoice</dt><dd>{utcDate(nextInvoice(usage))}</dd></div>}
      </dl>
      {ceiling !== null && <p className="text-[13px] text-muted-foreground">
        {account} can be charged up to {money(ceiling)} a month until it has paid {money(spending.next.paidUsd)} in total{spending.next.monthlyUsd === null
          ? ', then only the review limit applies.' : `, then up to ${money(spending.next.monthlyUsd)}.`} Paid so far: {money(spending.paidUsd)}.
      </p>}
      {usage.unknownCostReviews > 0 && <p className="text-[13px] text-muted-foreground">
        Leaves out {plural(usage.unknownCostReviews, 'review')} whose cost is not settled yet.
      </p>}
    </CardContent>
  </Card>;
}

// The organization's card, saved through Stripe Checkout.
function PaymentMethod({ installation, checkout, patchInstallation }) {
  const { billing, account, plan } = installation;
  // `pending` is 'checkout' while Stripe's page is being opened and 'confirm' while a return is checked.
  const [status, setStatus] = useState({ pending: null, error: null, saved: null });
  const confirmed = useRef(null);

  // Stripe returns here with ?checkout=<session>; the server checks it saved a card for this organization.
  useEffect(() => {
    if (!checkout || confirmed.current === checkout) return;
    confirmed.current = checkout;
    window.history.replaceState(null, '', routeHref({ view: 'billing', installation: installation.id }));
    setStatus({ pending: 'confirm', error: null, saved: null });
    api.billingConfirm(installation.id, checkout).then(result => {
      const { card, ...change } = result;
      console.info(`atmin review: card saved for installation ${installation.id}`);
      patchInstallation(installation.id, change);
      setStatus({ pending: null, error: null, saved: card });
    }, failure => {
      console.info(`atmin review: card confirmation failed for installation ${installation.id}: ${failure.status}`);
      setStatus({ pending: null, error: failure.message, saved: null });
    });
  }, [checkout, installation.id, patchInstallation]);

  async function addCard() {
    setStatus({ pending: 'checkout', error: null, saved: null });
    try {
      const { url } = await api.billingCheckout(installation.id);
      window.location.assign(url);
    } catch (failure) {
      console.info(`atmin review: card checkout failed for installation ${installation.id}: ${failure.status}`);
      setStatus({ pending: null, error: failure.message, saved: null });
    }
  }

  const action = <Button variant={billing.card && !billing.unpaid ? 'outline' : 'default'} disabled={status.pending !== null} onClick={addCard}>
    {status.pending === 'checkout' ? 'Opening Stripe…' : billing.unpaid ? 'Add a new card' : billing.card ? 'Replace card' : 'Add card'}
  </Button>;
  return <Card>
    <CardHeader><h2 className="panel-title">Payment method</h2></CardHeader>
    <CardContent className="grid gap-4">
      {status.pending === 'confirm' && <Notice>Checking the card with Stripe…</Notice>}
      {status.saved && <Notice>Card saved: {status.saved}.</Notice>}
      {status.error && <Notice tone="error">{status.error}</Notice>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground"><CreditCard aria-hidden="true" className="size-5"/></span>
        {billing.card
          ? <div className="grid min-w-48 flex-1 gap-0.5">
            <p className="font-medium">{billing.card}</p>
            <p className="text-[13px] text-muted-foreground">
              {billing.expires ? `Expires ${billing.expires}. ` : ''}{billing.email ? `Receipts go to ${billing.email}.` : 'Stripe has no email for receipts.'}
            </p>
          </div>
          : <div className="grid min-w-48 flex-1 gap-0.5">
            <p className="font-medium">No card on file</p>
            <p className="text-[13px] text-muted-foreground">Reviews stop after the {plural(plan.freeReviews, 'free review')} each month until a card is added.</p>
          </div>}
        {action}
      </div>
      <p className="text-[13px] text-muted-foreground">
        {billing.unpaid ? `Saving a new card charges it for the unpaid invoice for ${monthName(billing.unpaid)} straight away.` : 'Saving a card charges nothing.'} Stripe keeps
        the card details; only an admin of a repository connected in {account} can change it.
      </p>
    </CardContent>
  </Card>;
}

// Monthly invoices, newest first. Stripe's page for each shows the invoice and its receipt, and
// takes payment for one the card did not pay.
function Invoices({ installation }) {
  const { billing, usage } = installation;
  return <Card className="panel">
    <CardHeader className="panel-toolbar border-b"><h2 className="panel-title">Invoices</h2></CardHeader>
    <div className="panel-table overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Month</TableHead>
            <TableHead className="text-right max-sm:hidden">Reviews</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead><span className="sr-only">Invoice</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {billing.invoices.length === 0 && <TableRow>
            <TableCell colSpan={5} className="empty-cell">
              No invoices yet. {billing.card ? `The first is made on ${utcDate(nextInvoice(usage))}, for ${monthName(usage.month)}.` : 'Invoices start once a card is added.'}
            </TableCell>
          </TableRow>}
          {billing.invoices.map(invoice => {
            const state = invoiceStates[invoice.state] ?? { label: invoice.state, variant: 'outline' };
            return <TableRow key={invoice.month}>
              <TableCell>{monthName(invoice.month)}</TableCell>
              <TableCell className="text-right max-sm:hidden"><Figure>{count(invoice.reviews)}</Figure></TableCell>
              <TableCell className="text-right"><Figure>{usd(invoice.amountCents / 100)}</Figure></TableCell>
              <TableCell><Badge variant={state.variant}>{state.label}</Badge></TableCell>
              <TableCell className="text-right">
                {invoice.url && <a className="link" href={invoice.url} target="_blank" rel="noreferrer"
                  onClick={() => console.info(`atmin review: invoice for ${invoice.month} opened (${invoice.state})`)}>
                  {['failed', 'uncollectible'].includes(invoice.state) ? 'Pay' : 'View'}<span className="max-sm:hidden"> invoice</span>
                </a>}
              </TableCell>
            </TableRow>;
          })}
        </TableBody>
      </Table>
    </div>
  </Card>;
}

export function BillingPage({ installation, checkout, patchInstallation }) {
  const { account, billing } = installation;
  if (!billing) {
    return <PageHeader title="Billing">Billing is not set up on this atmin service. {account} gets its free reviews each month.</PageHeader>;
  }
  return <>
    <PageHeader title="Billing">How {account} pays for reviews past its free ones. Invoices go out on the 2nd of each month, in US dollars.</PageHeader>
    <div className="grid grid-cols-1 gap-4">
      <UsageNotice installation={installation}/>
      <div className="usage-grid">
        <PlanCard installation={installation}/>
        <MonthCard installation={installation}/>
      </div>
      <PaymentMethod installation={installation} checkout={checkout} patchInstallation={patchInstallation}/>
      <Invoices installation={installation}/>
    </div>
  </>;
}
