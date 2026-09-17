"""Run the pinned upstream extractor, deduplicator, judge and profile scorer.

Only transport accounting/concurrency differ: no SDK retries, bounded output,
and a durable $5 reservation ledger. Unknown charges keep their reservation.
Review failures remain empty candidate sets, never omitted PRs. Grading failures
are explicit and prevent a final score, rather than silently counting as misses.
"""
import asyncio
from functools import partial
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace

from openai import AsyncOpenAI


def read(path):
    return json.loads(path.read_text())


def save(path, value):
    pending = path.with_suffix(path.suffix + ".pending")
    pending.write_text(json.dumps(value, indent=2) + "\n")
    pending.replace(path)


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    sys.modules[name] = loaded
    spec.loader.exec_module(loaded)
    return loaded


def limit_judge_concurrency(judge_module):
    # Changing BATCH_SIZE does not change process_batch's already-bound default.
    judge_module.process_batch = partial(judge_module.process_batch, batch_size=3)


class Meter:
    def __init__(self, directory):
        self.path = directory / "judge-cost.json"
        self.state = read(self.path) if self.path.exists() else {"maxUsd": 5, "calls": []}
        self.client = AsyncOpenAI(api_key=os.environ["MARTIAN_API_KEY"], base_url=os.environ["MARTIAN_BASE_URL"], max_retries=0, timeout=28)
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    async def create(self, **kwargs):
        # One byte per input token plus framing is deliberately conservative.
        reserve = (len(json.dumps(kwargs["messages"]).encode()) + 4096) * .00000175 + 8192 * .000014
        if sum(call["chargedOrReservedUsd"] for call in self.state["calls"]) + reserve > self.state["maxUsd"]:
            raise RuntimeError("Judge budget exhausted")
        call = {"id": len(self.state["calls"]) + 1, "startedAt": time.time(), "status": "reserved",
                "promptHash": hashlib.sha256(json.dumps(kwargs["messages"]).encode()).hexdigest(), "chargedOrReservedUsd": reserve}
        self.state["calls"].append(call)
        save(self.path, self.state)
        try:
            response = await self.client.chat.completions.create(**kwargs, max_tokens=8192)
            usage = response.usage.model_dump() if response.usage else {}
            cost = usage.get("cost")
            if not isinstance(cost, (int, float)) or cost < 0:
                raise RuntimeError("Missing settlement")
            call.update(status="settled", chargedOrReservedUsd=cost, usage=usage, responseId=response.id, model=response.model)
            if response.choices[0].finish_reason != "stop":
                raise RuntimeError("Incomplete judge response")
            return response
        except BaseException:
            if call["status"] != "settled":
                call["status"] = "unknown-charge"
            raise RuntimeError("Judge transport or completion failed; reservation retained") from None
        finally:
            call["elapsedMs"] = round((time.time() - call["startedAt"]) * 1000)
            save(self.path, self.state)


async def main(directory):
    upstream = directory / "upstream/offline"
    manifest = read(directory / "comparison.json")
    # Record the exact unchanged upstream sources and this adapter before grading.
    sources = [upstream / "code_review_benchmark" / name for name in ["step2_extract_comments.py", "step2_5_dedup_candidates.py", "step3_judge_comments.py"]]
    sources += [upstream / "analysis/score_profiles.py", Path(__file__)]
    fingerprints = {str(path.relative_to(directory)) if path.is_relative_to(directory) else path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}
    frozen_path = directory / "grader-protocol.json"
    protocol = {"upstreamCommit": manifest["upstreamCommit"], "files": fingerprints, "model": "openai/gpt-5.2", "profile": "core", "beta": 2,
                "maxUsd": 5, "maxOutputTokens": 8192, "sdkRetries": 0, "upstreamRetries": "unchanged", "parallelJudgeCalls": 3, "trialCount": len(manifest["trials"])}
    if frozen_path.exists() and read(frozen_path) != protocol:
        raise RuntimeError("Frozen grader changed")
    save(frozen_path, protocol)
    extract = module("martian_extract", sources[0])
    dedup = module("martian_dedup", sources[1])
    judge_module = module("martian_judge", sources[2])
    scoring = module("martian_scoring", sources[3])
    limit_judge_concurrency(judge_module)
    os.environ["MARTIAN_MODEL"] = "openai/gpt-5.2"
    meter = Meter(directory)
    extractor, deduplicator, judge = extract.CandidateExtractor(), dedup.DedupLLM(), judge_module.LLMJudge()
    for stage in [extractor, deduplicator, judge]:
        await stage.client.close()
        stage.client = meter
    selected = {case["url"] for case in manifest["cases"]}
    gold = {}
    for path in (upstream / "golden_comments").glob("*.json"):
        for entry in read(path):
            if entry["url"] in selected:
                gold[entry["url"]] = entry["comments"]
    if gold.keys() != selected:
        raise RuntimeError("Development labels do not match frozen cases")
    categories = {comment["comment"]: comment["category"] for comments in gold.values() for comment in comments}
    path = directory / "grading.json"
    state = read(path) if path.exists() else {"trials": {}, "evaluations": {}, "final": False}
    try:
        while True:
            reviews = read(directory / "comparison-result.json")
            for trial in reviews["trials"]:
                if trial["id"] in state["trials"] or trial["status"] in ["preparing", "running"] or (trial["status"] == "unattempted" and not reviews["finishedAt"]):
                    continue
                url = next(case["url"] for case in manifest["cases"] if case["id"] == trial["caseId"])
                report_path = directory / "trials" / trial["id"] / "report.md"
                report = report_path.read_text() if report_path.exists() else ""
                record = {"reviewStatus": trial["status"], "reportHash": hashlib.sha256(report.encode()).hexdigest()}
                try:
                    extracted = await extractor.extract_from_comment(report)
                    if extracted.get("error"):
                        raise RuntimeError("Extraction failed")
                    candidates = extracted.get("issues", [])
                    if not isinstance(candidates, list) or not all(isinstance(c, str) for c in candidates):
                        raise RuntimeError("Invalid extracted issues")
                    groups = await deduplicator.dedup_candidates(candidates, dedup.DEDUP_PROMPT) if len(candidates) >= dedup.MIN_CANDIDATES else [[i] for i in range(len(candidates))]
                    if groups is None:
                        raise RuntimeError("Deduplication failed")
                    evaluation = await judge_module.evaluate_review(judge, gold[url], candidates, groups)
                    record.update(candidates=candidates, dedupGroups=groups, evaluation=evaluation)
                    if evaluation.get("errors_count"):
                        raise RuntimeError("Semantic judging failed")
                    state["evaluations"].setdefault(url, {})[trial.get("evaluationArm", trial["arm"])] = evaluation
                    record["status"] = "graded"
                except Exception as error:
                    record.update(status="grading-error", reason=str(error))
                state["trials"][trial["id"]] = record
                save(path, state)
                print(json.dumps({"trial": trial["id"], "status": record["status"], "candidates": len(record.get("candidates", [])), "tp": record.get("evaluation", {}).get("tp")}), flush=True)
            state["final"] = bool(reviews["finishedAt"]) and len(state["trials"]) == len(manifest["trials"]) and all(t["status"] == "graded" for t in state["trials"].values())
            state["scores"] = {profile: scoring.score_tools(state["evaluations"], categories, profile, 2) for profile in ["strict", "core", "all"]}
            save(path, state)
            if reviews["finishedAt"]:
                break
            await asyncio.sleep(10)
    finally:
        await meter.client.close()


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1]).resolve()))
