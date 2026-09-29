import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Button } from './ui/button.jsx';
import { Card, CardContent, CardHeader } from './ui/card.jsx';
import { Figure, Link, Notice, PageHeader, Progress } from './components.jsx';
import { count, monthName, plural, usd, utcDate } from './format.js';
import { routeHref } from './route.js';

// Shown wherever reviews are not running because of the organization's plan.
export function UsageNotice({ installation, link = false }) {
  const { plan, usage, account } = installation;
  const more = link && <Link className="link whitespace-nowrap" href={routeHref({ view: 'usage', installation: installation.id })}>View usage</Link>;
  if (plan.monthlyReviews === 0) {
    return <Notice action={more}>Reviews are turned off for {account}. Contact atmin to turn them on.</Notice>;
  }
  if (usage.reviews >= plan.monthlyReviews && installation.billing?.needsCard) {
    return <Notice action={more}>
      {account} used its {count(plan.freeReviews)} free reviews for {monthName(usage.month)}. A repository admin can add a card on the Usage page to keep reviewing; otherwise reviews resume on {utcDate(usage.resetsAt)}.
    </Notice>;
  }
  if (usage.reviews >= plan.monthlyReviews) {
    return <Notice action={more}>
      {account} used all {count(plan.monthlyReviews)} reviews for {monthName(usage.month)}. Until reviews resume on {utcDate(usage.resetsAt)}, pull requests get a “review not run” comment instead.
    </Notice>;
  }
  return null;
}

// The organization's card, saved through Stripe Checkout. Shown only when atmin has a Stripe key.
function Billing({ installation, checkout, patchInstallation }) {
  const { billing, account, plan } = installation;
  // `pending` is 'checkout' while Stripe's page is being opened and 'confirm' while a return is checked.
  const [status, setStatus] = useState({ pending: null, error: null, saved: null });
  const confirmed = useRef(null);

  // Stripe returns here with ?checkout=<session>; the server checks it saved a card for this organization.
  useEffect(() => {
    if (!checkout || confirmed.current === checkout) return;
    confirmed.current = checkout;
    window.history.replaceState(null, '', routeHref({ view: 'usage', installation: installation.id }));
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

  return <Card>
    <CardHeader><h2 className="panel-title">Card</h2></CardHeader>
    <CardContent className="grid justify-items-start gap-4">
      {status.pending === 'confirm' && <Notice>Checking the card with Stripe…</Notice>}
      {status.saved && <Notice>Card saved: {status.saved}. {account} can now use up to {count(plan.monthlyReviews)} reviews a month.</Notice>}
      {status.error && <Notice tone="error">{status.error}</Notice>}
      {billing.card
        ? <p><span className="font-medium">{billing.card}</span> <span className="text-muted-foreground">pays for reviews past the free ones. Stripe invoices it on the 2nd of each month for the month before.</span></p>
        : <p className="text-muted-foreground">
          {account} has no card on file, so reviews stop after its {plural(plan.freeReviews, 'free review')} each month. With a card, reviews continue and the ones past the free allowance are invoiced on the 2nd of the next month, at the price each PR comment shows.
        </p>}
      <Button variant={billing.card ? 'outline' : 'default'} disabled={status.pending !== null} onClick={addCard}>
        {status.pending === 'checkout' ? 'Opening Stripe…' : billing.card ? 'Replace card' : 'Add card'}
      </Button>
      <p className="text-[13px] text-muted-foreground">Stripe keeps the card. Saving it charges nothing. Only an admin of a connected repository can change it.</p>
    </CardContent>
  </Card>;
}

export function UsagePage({ installation, checkout, patchInstallation }) {
  const { plan, usage, account } = installation;
  const free = Math.max(0, plan.freeReviews - usage.reviews);
  const off = plan.monthlyReviews === 0;
  return <>
    <PageHeader title="Usage">
      Reviews for {account} in {monthName(usage.month)}. Counts reset on {utcDate(usage.resetsAt)} at 00:00 UTC.
    </PageHeader>
    <div className="grid grid-cols-1 gap-4">
      <UsageNotice installation={installation}/>
      <div className="usage-grid">
        <Card>
          <CardHeader><h2 className="panel-title">Reviews this month</h2></CardHeader>
          <CardContent className="grid gap-4">
            <p className="flex items-baseline gap-2">
              <Figure className="text-[28px] leading-none">{count(usage.reviews)}</Figure>
              <span className="text-muted-foreground">{off ? 'reviews started' : <>of <Figure>{count(plan.monthlyReviews)}</Figure></>}</span>
            </p>
            {!off && <Progress value={usage.reviews} max={plan.monthlyReviews} label={`${usage.reviews} of ${plan.monthlyReviews} reviews used this month`}/>}
            <dl className="facts">
              {!off && <div><dt>Free reviews left</dt><dd><Figure>{count(free)}</Figure> of <Figure>{count(plan.freeReviews)}</Figure></dd></div>}
              <div><dt>Reviews left this month</dt><dd><Figure>{count(usage.remaining)}</Figure></dd></div>
              <div><dt>Resets</dt><dd>{utcDate(usage.resetsAt)}</dd></div>
            </dl>
            <p className="text-[13px] text-muted-foreground">Counts every review that started this month, including failed ones.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><h2 className="panel-title">Estimated charges</h2></CardHeader>
          <CardContent className="grid gap-4">
            <p><Figure className="text-[28px] leading-none">{usd(usage.estimatedUsd)}</Figure></p>
            <p className="text-muted-foreground">An estimate for reviews beyond the {plural(plan.freeReviews, 'free review')} this month.</p>
            {usage.unknownCostReviews > 0 && <p className="text-[13px] text-muted-foreground">
              The estimate leaves out {plural(usage.unknownCostReviews, 'review')} whose cost is not settled yet.
            </p>}
          </CardContent>
        </Card>
      </div>
      {installation.billing && <Billing installation={installation} checkout={checkout} patchInstallation={patchInstallation}/>}
    </div>
  </>;
}
