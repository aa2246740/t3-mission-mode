"""Upstream 0.240.0 scoring, including its partial-credit and empty-report behavior.

This module is deliberately separate from report validation. Its native scoring
core tolerates missing criteria and nonpositive denominators, as the CLI does;
the report submission boundary must validate complete evaluation records.

Numbers at this boundary must be finite JSON numbers representable as binary64
(or null for a skipped numerator). Python integers are converted to binary64,
matching JavaScript JSON.parse. Intermediate overflow and invalid arithmetic
are preserved until JSON output normalization, where non-finite results become
null, matching JSON.stringify. This does not relax complete-report validation.
"""

import math
from collections.abc import Mapping

from .catalog import load_catalog


def status(evaluation: Mapping) -> str:
    """Match the native `_g` status helper (partial credit is still a failure)."""
    evaluation = _binary64_evaluation(evaluation)
    if evaluation["numerator"] is None:
        return "skipped"
    if evaluation["denominator"] > 0 and evaluation["numerator"] == evaluation["denominator"]:
        return "passed"
    return "failed"


def _binary64_number(value: object, field: str) -> float:
    if type(value) not in (int, float):
        raise ValueError(f"{field} must be a finite JSON number")
    try:
        number = float(value)
    except OverflowError as error:
        raise ValueError(f"{field} is outside finite binary64 range") from error
    if not math.isfinite(number):
        raise ValueError(f"{field} must be finite; NaN and Infinity are not supported input numbers")
    return number


def _binary64_evaluation(evaluation: Mapping) -> dict:
    if not isinstance(evaluation, Mapping):
        raise ValueError("Expected a criterion evaluation object")
    if "numerator" not in evaluation or "denominator" not in evaluation:
        raise ValueError("A criterion evaluation requires numerator and denominator")
    numerator = evaluation["numerator"]
    return {
        "numerator": None if numerator is None else _binary64_number(numerator, "numerator"),
        "denominator": _binary64_number(evaluation["denominator"], "denominator"),
    }


def _ratio(evaluation: Mapping | None) -> float | None:
    if evaluation is None or evaluation["numerator"] is None or evaluation["denominator"] <= 0:
        return None
    return evaluation["numerator"] / evaluation["denominator"]


def _native_round(value: float) -> float:
    # Python round() uses ties-to-even; JavaScript Math.round() ties toward +inf.
    if not math.isfinite(value):
        return value
    lower = math.floor(value)
    return float(lower + (value - lower >= 0.5))


def _native_ceil(value: float) -> float:
    return float(math.ceil(value)) if math.isfinite(value) else value


def _json_safe(value):
    """Match JSON.stringify's treatment of non-finite numbers and negative zero."""
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        if value.is_integer() and abs(value) <= 2 ** 53 - 1:
            return int(value)
        return value
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    return value


def _level(percent: float) -> int:
    for threshold, level in ((80, 5), (60, 4), (40, 3), (20, 2)):
        if percent >= threshold:
            return level
    return 1


def _progress(credit: float, count: int) -> dict:
    return {
        "checksPassed": _native_round(credit * 100),
        "checksTotal": count * 100,
        "percentComplete": credit / count * 100 if count else 0,
    }


def score_report(evaluations: Mapping[str, Mapping]) -> dict:
    """Score an ID -> {numerator, denominator, rationale} evaluation map.

Each applicable criterion contributes equal weight, regardless of its number of
applications. Skipped and missing criteria do not enter the denominator. Native
`checksPassed` and `checksTotal` use hundredths of a criterion, not check counts.

Five native output fields are preserved. `scorePercent` is a convenience alias
for overallProgress.percentComplete; `categoryBreakdowns` is a local extension
that applies the same equal-weight rule independently within each category.
"""
    catalog = load_catalog()
    criteria = catalog["criteria"]
    if not isinstance(evaluations, Mapping):
        raise ValueError("Expected an ID-to-evaluation object")
    evaluations = {
        criterion["id"]: _binary64_evaluation(evaluations[criterion["id"]])
        for criterion in criteria
        if evaluations.get(criterion["id"]) is not None
    }
    level_breakdowns = []
    total_credit = 0.0
    total_count = 0
    # Preserve native per-level accumulation order, including floating-point
    # effects at grade boundaries. Do not replace this with a weighted sum.
    for level in catalog["levels"]:
        credit = 0.0
        count = 0
        for criterion in criteria:
            if criterion["level"] != level["level"]:
                continue
            ratio = _ratio(evaluations.get(criterion["id"]))
            if ratio is not None:
                credit += ratio
                count += 1
        level_breakdowns.append({
            "level": level["level"],
            **_progress(credit, count),
            "isUnlocked": True,
        })
        total_credit += credit
        total_count += count

    overall = _progress(total_credit, total_count)
    achieved_level = _level(overall["percentComplete"])
    checks_needed = None
    if achieved_level < 5 and total_count > 0:
        remaining_percentage = achieved_level * 20 - total_credit / total_count * 100
        # Math.max propagates NaN; Python max(0, nan) would silently return zero.
        if not math.isnan(remaining_percentage):
            remaining_percentage = max(0, remaining_percentage)
        checks_needed = _native_ceil(remaining_percentage / 100 * total_count)

    criterion_results = []
    for criterion in criteria:
        evaluation = evaluations.get(criterion["id"])
        missing = evaluation is None
        skipped = not missing and evaluation["numerator"] is None
        passed = 0 if missing or skipped else evaluation["numerator"]
        total = 1 if missing else evaluation["denominator"]
        criterion_results.append({
            "criterionId": criterion["id"],
            "level": criterion["level"],
            "passed": passed,
            "total": total,
            "isComplete": not missing and not skipped and passed == total,
            "isSkipped": skipped,
        })

    categories = []
    for category in catalog["categories"]:
        credit = 0.0
        count = 0
        for criterion in criteria:
            if criterion["category"] != category["id"]:
                continue
            ratio = _ratio(evaluations.get(criterion["id"]))
            if ratio is not None:
                credit += ratio
                count += 1
        categories.append({
            "categoryId": category["id"],
            "name": category["name"],
            **_progress(credit, count),
        })

    return _json_safe({
        "achievedLevel": achieved_level,
        "overallProgress": overall,
        "levelBreakdowns": level_breakdowns,
        "checksNeededForNextLevel": checks_needed,
        "criterionResults": criterion_results,
        "scorePercent": overall["percentComplete"],
        "categoryBreakdowns": categories,
    })
