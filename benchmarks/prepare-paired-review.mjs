import {cpSync,mkdirSync,readFileSync,writeFileSync,readdirSync,existsSync,realpathSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash,loadReview} from '../dist/snapshot.js';
import {validatePlan} from './paired-review.mjs';

export function prepare(directory, baseline, source) {
  const review=fileURLToPath(new URL('../',import.meta.url));
  const split=JSON.parse(readFileSync(join(review,'benchmarks/martian-development-split.json')));
  const previous=JSON.parse(readFileSync(join(source,'comparison.json')));
  const development=new Set(split.cases.filter(c=>c.split==='development').map(c=>c.id));
  const seed='atmin-controller-pairs-20260914-v1';
  const cases=previous.cases.filter(c=>development.has(c.id)).sort((a,b)=>hash(seed+a.id).localeCompare(hash(seed+b.id)));
  if(cases.length!==15)throw Error('All 15 frozen development cases are required');
  const trials=[1,2].flatMap(repeat=>cases.flatMap(c=>{
    const order=parseInt(hash(seed+c.id).slice(0,2),16)%2?['baseline','candidate']:['candidate','baseline'];
    if(repeat===2)order.reverse();
    return order.map(arm=>({id:`${c.id}-${arm}-r${repeat}`,caseId:c.id,arm,repeat,evaluationArm:`${arm}-r${repeat}`}));
  }));
  const manifest={kind:'frozen-controller-repeat-comparison',createdAt:new Date().toISOString(),seed,
    upstreamCommit:split.benchmarkCommit,model:'gpt-5.6-sol',reasoning:'medium',
    engines:{baseline:'r02-24; same repaired adapter as candidate',candidate:'r02-26 / cdd925d'},
    concurrency:3,repeats:2,judge:{model:'openai/gpt-5.2',maxUsd:5,primaryProfile:'core',beta:2},
    protocol:'Paired source-only development comparison, three PR pairs at a time, opposite arm order on repeat two. All attempts retained, no silent retries. Common adapter, model, profile, renderer and snapshots; controller workflow differs. Reserved cases and labels are excluded.',
    cases,trials,files:{}};
  validatePlan(manifest);
  mkdirSync(directory);
  cpSync(join(baseline,'engine'),join(directory,'baseline'),{recursive:true});
  cpSync(join(baseline,'engine'),join(directory,'engine'),{recursive:true});
  for(const part of ['src','dist'])cpSync(join(review,part),join(directory,'engine',part),{recursive:true});
  for(const name of ['paired-review.mjs','prepare-paired-review.mjs','codex-model.mjs','martian-grade.py','paired-review.md'])
    cpSync(join(review,'benchmarks',name),join(directory,'engine/benchmarks',name));
  cpSync(join(review,'benchmarks/codex-model.mjs'),join(directory,'baseline/benchmarks/codex-model.mjs'));
  for(const c of cases){
    const path=join(source,'cases',c.id),{result}=loadReview(path);
    if(result.status!=='not-started'||hash(readFileSync(join(path,'packet.json')))!==c.packetHash||hash(readFileSync(join(path,'change.diff')))!==c.diffHash)throw Error('Frozen case changed');
    cpSync(path,join(directory,'cases',c.id),{recursive:true});
  }
  for(const part of ['code_review_benchmark','analysis'])cpSync(join(source,'upstream/offline',part),join(directory,'upstream/offline',part),{recursive:true,filter:p=>!p.includes('__pycache__')});
  const urls=new Set(cases.map(c=>c.url));
  mkdirSync(join(directory,'upstream/offline/golden_comments'),{recursive:true});
  for(const name of readdirSync(join(source,'upstream/offline/golden_comments')).filter(n=>n.endsWith('.json'))){
    const selected=JSON.parse(readFileSync(join(source,'upstream/offline/golden_comments',name))).filter(c=>urls.has(c.url));
    if(selected.length)writeFileSync(join(directory,'upstream/offline/golden_comments',name),JSON.stringify(selected,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  function scan(dir){for(const e of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,e.name);if(e.isDirectory())scan(path);else if(e.isFile())manifest.files[relative(directory,path)]=hash(readFileSync(path));else throw Error('Unexpected link in frozen experiment');
  }}
  for(const name of ['engine','baseline','cases','upstream'])scan(join(directory,name));
  writeFileSync(join(directory,'comparison.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  return {directory,cases:cases.map(c=>c.id),trials:trials.length,files:Object.keys(manifest.files).length,manifestHash:hash(readFileSync(join(directory,'comparison.json')))};
}
if(process.argv[1]&&existsSync(process.argv[1])&&realpathSync(new URL(import.meta.url))===realpathSync(process.argv[1])){
  if(process.argv.length!==5)throw Error('Usage: prepare-paired-review.mjs <output> <repaired-baseline-pilot> <original-case-comparison>');
  console.log(JSON.stringify(prepare(...process.argv.slice(2).map(p=>resolve(p)))));
}
