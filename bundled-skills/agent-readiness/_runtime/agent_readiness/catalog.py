"""Load the versioned rubric statically recovered from the upstream public CLI (see NOTICE.md)."""

from copy import deepcopy
from functools import lru_cache
from importlib.resources import files
import json


CATALOG_VERSION = "0.240.0"


@lru_cache(maxsize=1)
def _catalog() -> dict:
    resource = files("agent_readiness").joinpath("data", "rules.json")
    return json.loads(resource.read_text(encoding="utf-8"))


def load_catalog() -> dict:
    """Return an independent copy so callers cannot mutate subsequent evaluations."""
    return deepcopy(_catalog())


def criteria_by_id() -> dict[str, dict]:
    """Return the native ordered criteria, indexed by their stable IDs."""
    return {criterion["id"]: criterion for criterion in load_catalog()["criteria"]}
