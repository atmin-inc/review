import { LogOut, RefreshCw } from 'lucide-react';
import { Button } from './ui/button.jsx';
import { Card, CardContent } from './ui/card.jsx';
import { Avatar, Brand, Mark, Notice, userAvatar } from './components.jsx';
import { signInHref } from './route.js';

const steps = [
  ['Install the App on an organization', 'Install the atmin review GitHub App and choose which repositories it can access.'],
  ['Connect repositories', 'Sign in here and connect up to 10 repositories for each organization.'],
  ['atmin comments on each pull request', 'atmin reviews pull requests in connected repositories and comments on GitHub with its findings.'],
];

export function Landing({ route, installUrl, error }) {
  return <div className="landing">
    <header className="landing-header"><Brand/></header>
    <main className="landing-main">
      <section className="landing-hero grid justify-items-start gap-6">
        <Mark box size={56}/>
        <div className="grid gap-3">
          <h1>atmin review</h1>
          <p className="max-w-[560px] text-base text-muted-foreground">atmin reviews pull requests on GitHub and comments with findings.</p>
        </div>
        {error && <Notice tone="error" className="w-full max-w-[560px]">{error}</Notice>}
        <div className="flex flex-wrap gap-2">
          <Button asChild><a href={signInHref(route)}>Sign in with GitHub</a></Button>
          {installUrl && <Button asChild variant="outline"><a href={installUrl}>Install on GitHub</a></Button>}
        </div>
        <p className="text-[13px] text-muted-foreground">20 reviews a month free for each organization.</p>
      </section>
      <section aria-labelledby="how" className="grid gap-4">
        <h2 id="how">How it works</h2>
        <ol className="steps">
          {steps.map(([title, text]) => <li key={title}>
            <h3>{title}</h3>
            <p>{text}</p>
          </li>)}
        </ol>
      </section>
    </main>
  </div>;
}

export function NoInstallations({ user, installUrl, onSignOut }) {
  return <div className="landing">
    <header className="landing-header">
      <Brand/>
      <span className="flex items-center gap-2 text-sm">
        <Avatar src={userAvatar(user.id)} name={user.login}/>{user.login}
        <Button variant="ghost" onClick={onSignOut}><LogOut aria-hidden="true"/>Sign out</Button>
      </span>
    </header>
    <main className="landing-main">
      <Card className="max-w-[560px]">
        <CardContent className="grid justify-items-start gap-4">
          <h1 className="text-[22px]">Install atmin review on GitHub</h1>
          <p className="text-muted-foreground">You are signed in as {user.login}. atmin review is not installed on an organization you can access yet. Install the GitHub App on an organization, then connect its repositories here.</p>
          <div className="flex flex-wrap gap-2">
            {installUrl && <Button asChild><a href={installUrl}>Install on GitHub</a></Button>}
            <Button variant="outline" onClick={() => window.location.reload()}><RefreshCw aria-hidden="true"/>Reload</Button>
          </div>
        </CardContent>
      </Card>
    </main>
  </div>;
}
