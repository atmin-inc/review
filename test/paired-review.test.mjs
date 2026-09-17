import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {setImmediate} from 'node:timers/promises';
import {validatePlan, compare} from '../benchmarks/paired-review.mjs';
import {hash} from '../dist/snapshot.js';

function plan() {
  const cases=Array.from({length:15},(_,i)=>({id:`case-${i}`,packetHash:hash('{}'),diffHash:hash('diff')}));
  const trials=[1,2].flatMap(repeat=>cases.flatMap(c=>(repeat===1?['baseline','candidate']:['candidate','baseline']).map(arm=>({id:`${c.id}-${arm}-r${repeat}`,caseId:c.id,arm,repeat,evaluationArm:`${arm}-r${repeat}`}))));
  return {kind:'frozen-controller-repeat-comparison',cases,trials,files:{}};
}

test('paired protocol keeps every repeat distinct and reverses order',()=>{
  const good=plan();validatePlan(good);
  const state={...plan(),kind:'frozen-repository-state-comparison'};
  assert.throws(()=>validatePlan(state),/frozen repository state/);
  state.states=Object.fromEntries(state.cases.map(c=>[c.id,`states/${c.id}/repository-state.json`]));
  assert.throws(()=>validatePlan(state),/frozen repository state/);
  for(const path of Object.values(state.states))state.files[path]=hash('state');
  validatePlan(state);
  assert.throws(()=>validatePlan({...plan(),kind:'unknown'}));
  for(const change of [m=>m.trials.pop(),m=>m.trials[0].arm='unknown',m=>m.trials[0].evaluationArm='baseline',m=>m.trials[0].caseId='../outside',m=>m.trials[0].id=m.trials[1].id,m=>m.trials.push(m.trials.shift())]) {
    const bad=structuredClone(good);change(bad);assert.throws(()=>validatePlan(bad));
  }
});

test('paired dispatch selects isolated engines, retains all 60 outcomes and refuses changed frozen files',async t=>{
  const root=mkdtempSync(join(tmpdir(),'atmin-paired-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const manifest={...plan(),kind:'frozen-repository-state-comparison',states:{}};
  const write=(path,source)=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),source);manifest.files[path]=hash(source);};
  for(const c of manifest.cases){write(`states/${c.id}/repository-state.json`,`state-${c.id}`);manifest.states[c.id]=`states/${c.id}/repository-state.json`;}
  write('engine/package.json','{"type":"module"}');write('baseline/package.json','{"type":"module"}');
  write('dispatch.mjs',`export const starts=[]; export let active=0, maximum=0, releaseSlow, finishFast;
    export const slow=new Promise(resolve=>releaseSlow=resolve), fast=new Promise(resolve=>finishFast=resolve);
    export async function enter(directory) { const id=directory.split('/').at(-1); starts.push(id); maximum=Math.max(maximum,++active);
      try { if(id==='case-1-candidate-r1') finishFast(); if(id==='case-0-baseline-r1') await slow; else await Promise.resolve(); } finally { active--; } }`);
  const review=arm=>`import {enter} from '../../dispatch.mjs'; export const owner=Symbol('runtime'); export async function runReview(directory, profile, model) { await enter(directory); if(model.owner!==owner) throw Error('Adapter loaded through wrong runtime'); return {result:{status:'completed',arm:'${arm}',findings:[],evidence:[],coverage:[]},receipt:{startedAt:new Date(0).toISOString(),finishedAt:new Date(100).toISOString(),calls:[],toolCalls:0,toolErrors:[],stopReason:'finished'}}; }`;
  write('engine/dist/run.js',review('candidate')+`export function readProfile(){return {provider:'codex-local'};}`);
  write('baseline/dist/run.js',review('baseline'));
  write('engine/dist/snapshot.js',`export function loadReview(){return {packet:{},result:{status:'not-started'}};}`);
  write('engine/dist/assessment.js',`export function assess(){return {};}`);
  write('engine/dist/render.js',`export function renderMarkdown(packet,result){return result.arm;}`);
  for(const directory of ['engine','baseline'])write(`${directory}/benchmarks/codex-model.mjs`,`import {owner} from '../dist/run.js'; export async function codexModel(){return {owner,close(){}};}`);
  for(const c of manifest.cases){write(`cases/${c.id}/packet.json`,'{}');write(`cases/${c.id}/change.diff`,'diff');}
  writeFileSync(join(root,'comparison.json'),JSON.stringify(manifest));
  const dispatch=await import(pathToFileURL(join(root,'dispatch.mjs')).href);
  const pending=compare(root);
  try {
    await dispatch.fast; await setImmediate();
    assert.ok(dispatch.starts.includes('case-3-baseline-r1'),'a free slot starts the next pair while the slow pair remains in flight');
    assert.ok(!dispatch.starts.some(id=>id.endsWith('-r2')),'the second repeat waits for the entire first repeat');
  } finally { dispatch.releaseSlow(); await pending; }
  const result=await pending;
  assert.ok(dispatch.maximum<=3);
  assert.equal(result.trials.length,60);assert.ok(result.trials.every(t=>t.status==='completed'));
  for(const trial of result.trials){
    assert.equal(readFileSync(join(root,'trials',trial.id,'report.md'),'utf8'),trial.arm);
    const state=join(root,'trials',trial.id,'repository-state.json');
    if(trial.arm==='candidate')assert.equal(readFileSync(state,'utf8'),`state-${trial.caseId}`);else assert.ok(!existsSync(state),'baseline trials never receive state');
  }
  await assert.rejects(compare(root),/EEXIST/);
  writeFileSync(join(root,'baseline/dist/run.js'),'throw Error("must not import")');
  await assert.rejects(compare(root),/Frozen experiment file changed/);
});
