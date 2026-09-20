#!/usr/bin/env python3
"""
Laya-MLX bridge for pi-warden.

Long-running subprocess: loads the model once, then reads JSON requests from
stdin and writes JSON responses to stdout.  stderr is reserved for logs.

Usage:
    python3 laya-bridge.py <model_dir>

Protocol (newline-delimited JSON):
    Request:  {"id": "...", "state": ..., "questions": {...}}
    Response: {"id": "...", "answers": {...}, "elapsed_ms": ..., "model": "..."}
"""

import json
import sys
import time
from pathlib import Path


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: laya-bridge.py <model_dir>"}))
        sys.exit(1)

    model_dir = sys.argv[1]
    if not Path(model_dir).is_dir():
        print(json.dumps({"error": f"model directory not found: {model_dir}"}))
        sys.exit(1)

    # Check Python version
    if sys.version_info < (3, 11):
        print(json.dumps({"error": f"Python 3.11+ required, got {sys.version}"}))
        sys.exit(1)

    # Load the model
    log(f"laya-bridge: loading model from {model_dir} ...")
    try:
        # Try laya_mlx first (Apple Silicon native)
        try:
            import laya_mlx as laya
            agent = laya.load(str(model_dir))
            model_name = "laya-mlx"
            log("laya-bridge: model loaded (laya_mlx)")
        except ImportError:
            # Fall back to standard laya
            import laya
            agent = laya.load(str(model_dir))
            model_name = "laya"
            log("laya-bridge: model loaded (laya)")
    except Exception as e:
        err = {"error": f"failed to load model: {e}"}
        print(json.dumps(err))
        sys.exit(1)

    # Signal readiness
    print(json.dumps({"ready": True, "model": model_name}), flush=True)

    # Main loop: read requests from stdin, write responses to stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            _send_error(None, f"invalid JSON: {e}")
            continue

        req_id = request.get("id")
        state = request.get("state")
        questions = request.get("questions")

        if not isinstance(questions, dict) or not questions:
            _send_error(req_id, "questions must be a non-empty object")
            continue

        # Convert pi-typesafe question format to laya format
        laya_questions = _convert_questions(questions)

        start = time.monotonic()
        try:
            result = agent.predict(state, laya_questions)
            elapsed_ms = int((time.monotonic() - start) * 1000)
        except Exception as e:
            _send_error(req_id, f"predict failed: {e}")
            continue

        # Convert laya answers back to pi-typesafe format
        answers = _convert_answers(result.get("answers", {}), questions)

        response = {
            "id": req_id,
            "answers": answers,
            "elapsed_ms": elapsed_ms,
            "model": model_name,
        }
        print(json.dumps(response), flush=True)


def _convert_questions(questions: dict) -> dict:
    """Convert pi-typesafe question format to laya format."""
    laya = {}
    for key, q in questions.items():
        if not isinstance(q, dict):
            continue
        q_type = q.get("type")
        instructions = q.get("instructions")
        criteria = q.get("criteria")

        if q_type == "noul":
            entry = {"type": "noul", "instructions": instructions}
            if isinstance(criteria, dict):
                entry["criteria"] = {
                    "true": criteria.get("true"),
                    "false": criteria.get("false"),
                }
            laya[key] = entry
        elif q_type == "choice":
            entry = {"type": "choice", "instructions": instructions}
            if isinstance(criteria, dict):
                entry["criteria"] = criteria
            laya[key] = entry
        elif q_type == "score":
            entry = {"type": "score", "instructions": instructions}
            if isinstance(criteria, list):
                entry["criteria"] = criteria
            laya[key] = entry
        else:
            # Unknown question type: skip
            log(f"laya-bridge: skipping unknown question type '{q_type}' for key '{key}'")
    return laya


def _convert_answers(laya_answers: dict, original_questions: dict) -> dict:
    """Convert laya answer format to pi-typesafe format."""
    converted = {}
    for key, answer in laya_answers.items():
        q = original_questions.get(key, {})
        q_type = q.get("type", "noul")
        if q_type == "noul":
            # laya returns {"noul": probability} or similar
            if isinstance(answer, dict):
                prob = answer.get("noul", answer.get("probability", answer.get("yes", 0.5)))
                converted[key] = {"type": "noul", "noul": float(prob) if isinstance(prob, (int, float)) else 0.5}
            elif isinstance(answer, (int, float)):
                converted[key] = {"type": "noul", "noul": float(answer)}
            else:
                converted[key] = {"type": "noul", "noul": 0.5}
        elif q_type == "choice":
            if isinstance(answer, dict):
                choice_val = answer.get("choice", answer.get("label", ""))
                conf = answer.get("confidence", 0.5)
                probs = answer.get("probabilities", {})
                converted[key] = {
                    "type": "choice",
                    "choice": str(choice_val),
                    "confidence": float(conf) if isinstance(conf, (int, float)) else 0.5,
                    "probabilities": {k: float(v) if isinstance(v, (int, float)) else 0.0 for k, v in probs.items()} if isinstance(probs, dict) else {},
                }
            elif isinstance(answer, str):
                converted[key] = {"type": "choice", "choice": answer, "confidence": 0.5, "probabilities": {}}
            else:
                converted[key] = {"type": "choice", "choice": "", "confidence": 0.0, "probabilities": {}}
        elif q_type == "score":
            if isinstance(answer, dict):
                score_val = answer.get("score", answer.get("value", 0))
                conf = answer.get("confidence", 0.5)
                probs = answer.get("probabilities", {})
                criteria = q.get("criteria", [])
                legend = {}
                for i, c in enumerate(criteria):
                    legend[str(i)] = c
                converted[key] = {
                    "type": "score",
                    "score": float(score_val) if isinstance(score_val, (int, float)) else 0.0,
                    "confidence": float(conf) if isinstance(conf, (int, float)) else 0.5,
                    "legend": legend,
                    "probabilities": {str(k): float(v) if isinstance(v, (int, float)) else 0.0 for k, v in probs.items()} if isinstance(probs, dict) else {},
                }
            elif isinstance(answer, (int, float)):
                converted[key] = {"type": "score", "score": float(answer), "confidence": 0.5, "legend": {}, "probabilities": {}}
            else:
                converted[key] = {"type": "score", "score": 0.0, "confidence": 0.0, "legend": {}, "probabilities": {}}
        else:
            # Pass through as-is for unknown types
            converted[key] = answer
    return converted


def _send_error(req_id, message):
    """Send an error response."""
    print(json.dumps({"id": req_id, "error": message}), flush=True)


if __name__ == "__main__":
    main()
