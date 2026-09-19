# Subagent Model Eval (2026-09-18)

Evaluated pi-warden's guard system using two subagent models as executors:
cheapestinference/deepseek-v4.1-flash and cheapestinference/mimo-v2.5.

## Setup

- Both models ran the full eval suite (12 categories, 146 cases per round)
- 3 rounds per model, executed via subagent delegation
- Additionally ran new hard-cases eval suite (C projects, Chinese content, Unicode edge cases)

## Results

| Model | Rounds | Categories | Cases | Pass Rate |
|-------|--------|------------|-------|-----------|
| deepseek-v4.1-flash | 3 | 12 | 438 | 100% |
| mimo-v2.5 | 3 | 12 | 438 | 100% |
| hard-cases (both) | 3 | 1 | 54 | 100% |

## Key Findings

1. Both models execute eval scripts identically. The guard judgments (via Jev) are model-independent.
2. Subagent delegation works with cheapestinference provider (previously aborted with 0 tokens on commandcode provider).
3. The hard-cases suite revealed:
   - C "boundary checks" rule flags all array indexing, even when the function does not own bounds checking. This is correct per the rule text.
   - Chinese rule IDs get slugified to ASCII identifiers (rule, rule-2, console-log). Functional but opaque in traces.
   - Em-dash detection works correctly after the Unicode literacy fix in the rules FRAME.

## Files

- `hard-cases-run1.txt` through `hard-cases-run3.txt`: raw output per round
