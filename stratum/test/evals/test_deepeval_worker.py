"""Offline contract tests for the named DeepEval metric adapter."""

import unittest

from evals.harness import deepeval_worker as worker


class FakeMetric:
    def __init__(self, score):
        self.score = score
        self.seen = None

    def measure(self, case):
        self.seen = case


class WorkerTests(unittest.TestCase):
    def test_both_metrics_receive_exact_case(self):
        created = []

        def factory(cls):
            metric = FakeMetric(0.75 if cls is worker.FaithfulnessMetric else 0.5)
            created.append((cls, metric))
            return metric

        request = {"query": "Which database?", "context": "We chose Postgres.", "answer": "Postgres."}
        self.assertEqual(worker.score(request, factory), {"faithfulness": 0.75, "answerRelevancy": 0.5})
        self.assertEqual([cls for cls, _ in created], [worker.FaithfulnessMetric, worker.AnswerRelevancyMetric])
        for _, metric in created:
            self.assertEqual(metric.seen.input, request["query"])
            self.assertEqual(metric.seen.actual_output, request["answer"])
            self.assertEqual(metric.seen.retrieval_context, [request["context"]])

    def test_metric_error_and_invalid_score_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "invalid score"):
            worker.score({"query": "q", "context": "c", "answer": "a"}, lambda _: FakeMetric(float("nan")))
        with self.assertRaisesRegex(ValueError, "must be strings"):
            worker.score({"query": "q", "context": None, "answer": "a"}, lambda _: FakeMetric(1))


if __name__ == "__main__":
    unittest.main()
