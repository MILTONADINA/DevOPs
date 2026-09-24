"""Line-oriented DeepEval scorer. Stdout is reserved for JSON protocol replies."""

import contextlib
import json
import math
import os
import sys

os.environ["DEEPEVAL_DISABLE_DOTENV"] = "1"
os.environ["DEEPEVAL_TELEMETRY_OPT_OUT"] = "YES"

with contextlib.redirect_stdout(sys.stderr):
    from deepeval.metrics import AnswerRelevancyMetric, FaithfulnessMetric
    from deepeval.models import AnthropicModel
    from deepeval.test_case import LLMTestCase


def score(request, metric_factory=None):
    if not all(isinstance(request.get(key), str) for key in ("query", "context", "answer")):
        raise ValueError("query, context, and answer must be strings")
    if metric_factory is None:
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            raise ValueError("Anthropic eval key is missing")
        model = AnthropicModel(model="claude-haiku-4-5-20251001", api_key=key, temperature=0)
        metric_factory = lambda cls: cls(model=model, eval_mode="llm", include_reason=False, async_mode=False)
    case = LLMTestCase(
        input=request["query"],
        actual_output=request["answer"],
        retrieval_context=[request["context"]],
    )
    scores = {}
    for name, cls in (("faithfulness", FaithfulnessMetric), ("answerRelevancy", AnswerRelevancyMetric)):
        metric = metric_factory(cls)
        with contextlib.redirect_stdout(sys.stderr):
            metric.measure(case)
        value = metric.score
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError(f"DeepEval {name} returned an invalid score")
        scores[name] = float(value)
    return scores


def main():
    for line in sys.stdin:
        try:
            result = {"ok": True, "scores": score(json.loads(line))}
        except Exception as exc:
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        print(json.dumps(result, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
