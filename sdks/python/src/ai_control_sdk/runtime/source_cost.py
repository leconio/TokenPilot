"""Provider-reported cost shared by manual usage and provider adapters."""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class SourceCost:
    """Exact or estimated amount reported for one model attempt."""

    amount: str
    currency: str
    is_estimated: bool = False

    def __post_init__(self) -> None:
        if re.fullmatch(r"(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?", self.amount) is None:
            raise ValueError("source cost amount must be a non-negative decimal")
        if re.fullmatch(r"[A-Z]{3}", self.currency) is None:
            raise ValueError("source cost currency must be an uppercase ISO currency code")


def source_cost_payload(value: SourceCost | None) -> dict[str, str | bool] | None:
    if value is None:
        return None
    return {
        "amount": value.amount,
        "currency": value.currency,
        "is_estimated": value.is_estimated,
    }
