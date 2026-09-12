"""Presentation-only voice normalization; never changes evidence values."""
import re


def executive_text(value):
    text = str(value or "")
    text = re.sub(r"\bI (?:see|found|observe)\s+", "", text)
    text = re.sub(r"\bI (?:recommend|suggest)\s+", "", text)
    text = text.replace("I use this as", "This is").replace("I have not run it", "that alternative has not been evaluated")
    text = text.replace("site(s)", "sites").replace("facility(ies)", "facilities")
    return re.sub(r"(^|[.!?]\s+)([a-z])", lambda m: m[1] + m[2].upper(), text)


def polish_result(result):
    for field in ("summary", "recommendation"):
        if hasattr(result, field):
            setattr(result, field, executive_text(getattr(result, field)))
    briefing = result.briefing
    if briefing:
        for field in ("opening", "context", "recommendation", "limitation"):
            setattr(briefing, field, executive_text(getattr(briefing, field)))
        for item in briefing.kpi_insights:
            item.headline = executive_text(item.headline)
            item.narrative = executive_text(item.narrative)
    return result
