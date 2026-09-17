"""Money-path checks; no model calls or credentials required."""
import asyncio
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("grade", Path(__file__).with_name("martian-grade.py"))
grade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grade)


class MeterTest(unittest.IsolatedAsyncioTestCase):
    async def test_concurrency_limit_overrides_the_upstream_bound_default(self):
        active = peak = 0

        async def request(index):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0)
            active -= 1
            return index

        async def process_batch(tasks, batch_size=20):
            results = []
            for i in range(0, len(tasks), batch_size):
                results.extend(await asyncio.gather(*tasks[i:i + batch_size]))
            return results

        upstream = SimpleNamespace(BATCH_SIZE=20, process_batch=process_batch)
        grade.limit_judge_concurrency(upstream)
        self.assertEqual(await upstream.process_batch([request(i) for i in range(8)]), list(range(8)))
        self.assertEqual(peak, 3)

    async def test_settlement_and_unknown_charge_are_durable_and_budgeted(self):
        calls = []

        async def create(**kwargs):
            calls.append(kwargs)
            if len(calls) > 1:
                raise TimeoutError("private transport details")
            return SimpleNamespace(usage=SimpleNamespace(model_dump=lambda: {"cost": .002}),
                                   id="fixture", model="fixture", choices=[SimpleNamespace(finish_reason="stop")])

        original = grade.AsyncOpenAI
        grade.AsyncOpenAI = lambda **_: SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        previous = {key: os.environ.get(key) for key in ["MARTIAN_API_KEY", "MARTIAN_BASE_URL"]}
        os.environ.update(MARTIAN_API_KEY="fixture", MARTIAN_BASE_URL="https://example.invalid")
        try:
            with tempfile.TemporaryDirectory() as directory:
                meter = grade.Meter(Path(directory))
                await meter.create(messages=[{"role": "user", "content": "fixture"}])
                self.assertEqual(meter.state["calls"][0]["chargedOrReservedUsd"], .002)
                with self.assertRaisesRegex(RuntimeError, "reservation retained"):
                    await meter.create(messages=[])
                self.assertEqual(meter.state["calls"][1]["status"], "unknown-charge")
                self.assertGreater(meter.state["calls"][1]["chargedOrReservedUsd"], .1)
                restored = grade.Meter(Path(directory))
                self.assertEqual(restored.state, meter.state)
                restored.state["maxUsd"] = .01
                with self.assertRaisesRegex(RuntimeError, "budget exhausted"):
                    await restored.create(messages=[])
                self.assertEqual(len(calls), 2)
        finally:
            grade.AsyncOpenAI = original
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


if __name__ == "__main__":
    unittest.main()
