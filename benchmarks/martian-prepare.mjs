import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture, hash, parsePullUrl } from '../dist/snapshot.js';
import { initialResult } from '../dist/contracts.js';
const exec = promisify(execFile);
const env = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Review snapshot', GIT_AUTHOR_EMAIL: 'snapshot@example.invalid', GIT_AUTHOR_DATE: '2026-09-11T00:00:00Z',
  GIT_COMMITTER_NAME: 'Review snapshot', GIT_COMMITTER_EMAIL: 'snapshot@example.invalid', GIT_COMMITTER_DATE: '2026-09-11T00:00:00Z' };
const flags = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper='];
async function git(directory, args) {
  const { stdout } = await exec('git', [...flags, '-C', directory, ...args], { env, timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2)+'\n', {flag:'wx', mode:0o600});

// Copy tree/blob objects only. Original commit history and messages, remote URLs,
// reflogs and future fixes never enter either reviewer's source repository.
export async function projectTrees(source, destination, base, head) {
  const merge = await git(source, ['merge-base', base, head]);
  const trees = await Promise.all([merge, base, head].map(ref => git(source, ['rev-parse', `${ref}^{tree}`])));
  mkdirSync(destination);
  await git(destination, ['init', '--bare', '--template=']);
  const objects = await git(source, ['rev-list', '--objects', '--no-object-names', ...new Set(trees)]);
  const pack = spawn('git', [...flags, '-C', source, 'pack-objects', '--stdout'], {env, stdio:['pipe','pipe','ignore']});
  const unpack = spawn('git', [...flags, '-C', destination, 'index-pack', '--stdin'], {env, stdio:['pipe','ignore','ignore']});
  const done = child => new Promise((resolve,reject) => { child.once('error',reject); child.once('close',code => code === 0 ? resolve() : reject(new Error('Object projection failed'))); });
  const pending = Promise.all([done(pack),done(unpack)]);
  pack.stdout.pipe(unpack.stdin); pack.stdin.end(objects+'\n');
  await pending;
  const mergeSha = await git(destination, ['commit-tree', trees[0], '-m', 'Comparison base']);
  const baseSha = trees[1] === trees[0] ? mergeSha : await git(destination, ['commit-tree', trees[1], '-p', mergeSha, '-m', 'Target snapshot']);
  const headSha = await git(destination, ['commit-tree', trees[2], '-p', mergeSha, '-m', 'Proposed change']);
  for (const [ref, sha] of [['comparison-base',mergeSha],['target',baseSha],['head',headSha]]) await git(destination,['update-ref',`refs/heads/${ref}`,sha]);
  await git(destination,['symbolic-ref','HEAD','refs/heads/head']);
  const projected = await Promise.all([mergeSha,baseSha,headSha].map(ref=>git(destination,['rev-parse',`${ref}^{tree}`])));
  if (JSON.stringify(trees)!==JSON.stringify(projected)) throw new Error('Projection changed a source tree');
  return { baseSha, headSha, originalMergeBaseSha:merge, mergeBaseTree:trees[0], baseTree:trees[1], headTree:trees[2] };
}

export async function prepare(directory, splitPath) {
  const split=JSON.parse(readFileSync(splitPath));
  const cases=split.cases.filter(c=>c.split==='development');
  if(cases.length!==15 || split.cases.filter(c=>c.split==='reserved').length!==35) throw new Error('Expected frozen 15/35 split');
  mkdirSync(join(directory,'cases'),{recursive:true});mkdirSync(join(directory,'staging'),{recursive:true});
  const state={splitHash:hash(readFileSync(splitPath)),startedAt:new Date().toISOString(),finishedAt:null,cases:cases.map(c=>({...c,status:'unprepared'}))};
  const statePath=join(directory,'preparation.json');save(statePath,state);
  const persist=()=>{save(statePath+'.pending',state);renameSync(statePath+'.pending',statePath);};
  const review=fileURLToPath(new URL('../',import.meta.url));
  const known={
    'https://github.com/grafana/grafana/pull/90939':'grafana-90939',
    'https://github.com/calcom/cal.com/pull/22345':'calcom-22345',
    'https://github.com/ai-code-review-evaluation/discourse-graphite/pull/6':'discourse-6',
  };
  for(let offset=0;offset<state.cases.length;offset+=3) {
    await Promise.all(state.cases.slice(offset,offset+3).map(async entry=>{
      entry.status='preparing';persist();
      try {
        const {repository}=parsePullUrl(entry.url);
        if(!/^[a-z0-9-]+$/.test(entry.id)||![entry.base,entry.head].every(s=>/^[a-f0-9]{40}$/.test(s)))throw Error('Invalid case identity');
        const cached=known[entry.url] && join(review,'.runs/martian-suite-20260911/cases',known[entry.url],'source.git');
        const source=cached&&existsSync(cached)?cached:join(directory,'staging',entry.id);
        if(source!==cached){mkdirSync(source);await git(source,['init','--bare','--template=']);await git(source,['fetch','--quiet','--no-tags','--depth=64',`https://github.com/${repository}.git`,entry.base,entry.head]);
          try{await git(source,['merge-base',entry.base,entry.head]);}catch{await git(source,['fetch','--quiet','--no-tags','--depth=512',`https://github.com/${repository}.git`,entry.base,entry.head]);}}
        const output=join(directory,'cases',entry.id);mkdirSync(output);
        const projected=await projectTrees(source,join(output,'source.git'),entry.base,entry.head);
        const {packet,diff}=capture(join(output,'source.git'),{repository:`atmin-benchmark/${entry.id}`,pr:1,baseRef:'target',state:'open',baseSha:projected.baseSha,headSha:projected.headSha});
        save(join(output,'packet.json'),packet);save(join(output,'result.json'),initialResult(packet));writeFileSync(join(output,'change.diff'),diff,{flag:'wx'});
        Object.assign(entry,projected,{status:'prepared',packetHash:hash(readFileSync(join(output,'packet.json'))),diffHash:packet.diffHash,diffBytes:diff.length,changedFiles:packet.changedFiles.length});
      }catch{entry.status='infrastructure-error';entry.reason='Source retrieval, projection or capture failed; case retained in split.';}
      persist();console.log(JSON.stringify({id:entry.id,status:entry.status,diffBytes:entry.diffBytes,changedFiles:entry.changedFiles}));
    }));
  }
  state.finishedAt=new Date().toISOString();persist();return state;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==4)throw Error('Usage: node martian-prepare.mjs <new-output-directory> <split.json>');
  const state=await prepare(resolve(process.argv[2]),resolve(process.argv[3]));
  process.exitCode=state.cases.every(c=>c.status==='prepared')?0:2;
}
