import { Brand } from './components.jsx';

// Who operates the service and how to reach them. Lors confirms these before launch (2026-10-06).
const operator = 'atmin';
const contact = 'legal@atmin.ai';
const governingLaw = 'the laws of the Province of Ontario and the federal laws of Canada that apply there';
const effective = 'October 6, 2026';

// Both pages describe what the service actually does; when retention, processors or billing
// change in code (src/github/runner.ts, src/openrouter-model.ts, src/github/billing.ts), change them here.
const terms = [
  ['The service', <>
    <p>atmin review ("the service") is operated by {operator} ("we", "us"). It reviews pull requests in GitHub repositories you connect and posts its findings as comments and checks on GitHub. By installing the atmin review GitHub App or signing in, you agree to these terms on behalf of yourself and the organization you install it on.</p>
  </>],
  ['Your account and repositories', <>
    <p>You sign in with GitHub. You may connect only repositories you are allowed to grant us access to. You are responsible for what happens under your installation, including who in your organization can connect repositories and buy credit.</p>
  </>],
  ['Your code stays yours', <>
    <p>You keep all rights to your code and pull requests. You give us permission to copy, process and send your code to the providers listed in the <a className="link" href="/privacy">Privacy Policy</a> only to run reviews you ask for, to show you their results and to keep the service secure. We do not use your code to train models and do not sell it.</p>
  </>],
  ['Reviews are advice', <>
    <p>Findings are produced by AI models and can be wrong or incomplete. A review is not a guarantee that code is correct or secure. You decide what to merge.</p>
  </>],
  ['Free reviews, credit and payment', <>
    <p>Each organization gets a number of free reviews each month, shown on its Usage page. After those, each review is charged from prepaid credit at the price shown for it. You buy credit by card through Stripe; you may choose to top it up automatically. Prices can change; a change applies only to reviews after it is shown in the service. Credit does not expire while the service runs. Unused credit is refundable on request to {contact} within 30 days of purchase; after that, credit is not refundable except where the law requires.</p>
  </>],
  ['Acceptable use', <>
    <p>Do not use the service to break the law, to attack or overload it or anyone else, to get around its limits, or to review code you have no right to share with us. We may suspend an installation that does, or that we reasonably believe puts the service or other customers at risk.</p>
  </>],
  ['Availability and changes', <>
    <p>We aim to keep the service running but do not promise it will be uninterrupted. We may change or stop features. If we stop the service, we will refund unused credit.</p>
  </>],
  ['Ending', <>
    <p>You can stop at any time by uninstalling the GitHub App. We may end your access for a breach of these terms.</p>
  </>],
  ['Liability', <>
    <p>The service is provided "as is". To the extent the law allows, we are not liable for indirect or consequential losses, and our total liability for any claim is limited to the amount you paid us in the 12 months before it.</p>
  </>],
  ['Changes to these terms', <>
    <p>We will post changes here and update the date above. Continuing to use the service after a change means you accept it.</p>
  </>],
  ['Law and contact', <>
    <p>These terms are governed by {governingLaw}. Questions: <a className="link" href={`mailto:${contact}`}>{contact}</a>.</p>
  </>],
];

const privacy = [
  ['What we collect', <>
    <ul>
      <li><strong>GitHub account:</strong> your GitHub user ID and login when you sign in, and the organizations and repositories you install the App on or connect.</li>
      <li><strong>Code:</strong> the pull requests we review, the files they change and the code the review reads around them.</li>
      <li><strong>Review records:</strong> each review's findings, the diff it reviewed, its cost and timing.</li>
      <li><strong>Billing:</strong> your card brand, last four digits and expiry, and the email address entered at checkout, as reported by Stripe. We never see or store full card numbers.</li>
      <li><strong>Usage and logs:</strong> counts, sizes, errors and timings needed to run and debug the service. Our logs do not contain your code.</li>
    </ul>
  </>],
  ['How long we keep it', <>
    <ul>
      <li>A copy of a repository's history is kept on our review servers while it is being reviewed and deleted after 24 hours with no review of it.</li>
      <li>Review records, including the reviewed diff, are deleted after 90 days. The latest completed review of each pull request, and the comment published on GitHub, are kept.</li>
      <li>Account and billing records are kept while your installation is active and as long as the law requires for payment records.</li>
    </ul>
  </>],
  ['How we protect your code', <>
    <p>Each review runs in its own sandbox that can reach only that review and that one repository's copy. Access to our servers is limited to the people who operate the service.</p>
  </>],
  ['Who processes it', <>
    <ul>
      <li><strong>GitHub</strong>: where your code lives and where reviews are posted.</li>
      <li><strong>OpenRouter</strong> and <strong>Microsoft Azure</strong>: run the AI model that reads your code. Requests are sent only to routes OpenRouter lists as zero data retention, so the model provider does not keep them.</li>
      <li><strong>TypeSafe</strong>: checks some findings against short excerpts of the code they concern.</li>
      <li><strong>Stripe</strong>: takes card payments.</li>
      <li>Our hosting provider, which runs our servers.</li>
    </ul>
    <p>We do not sell your data or use your code to train models.</p>
  </>],
  ['Your choices', <>
    <p>You can disconnect repositories or uninstall the GitHub App at any time. To see, correct or delete your data, email <a className="link" href={`mailto:${contact}`}>{contact}</a>.</p>
  </>],
  ['Cookies', <>
    <p>We use cookies only to sign you in with GitHub and keep you signed in. We use no advertising or tracking cookies.</p>
  </>],
  ['Changes', <>
    <p>We will post changes here and update the date above.</p>
  </>],
];

export function LegalPage({ page }) {
  const [title, sections] = page === 'terms' ? ['Terms of Service', terms] : ['Privacy Policy', privacy];
  return <div className="landing">
    <header className="landing-header"><a href="/" aria-label="atmin review home"><Brand/></a></header>
    <main className="landing-main legal">
      <div className="grid gap-2">
        <h1>{title}</h1>
        <p className="text-muted-foreground">Effective {effective}</p>
      </div>
      {sections.map(([heading, body]) => <section key={heading} className="grid gap-2">
        <h2>{heading}</h2>
        {body}
      </section>)}
    </main>
    <LegalLinks/>
  </div>;
}

export function LegalLinks() {
  return <footer className="legal-links">
    <a className="link" href="/terms">Terms</a>
    <a className="link" href="/privacy">Privacy</a>
  </footer>;
}
