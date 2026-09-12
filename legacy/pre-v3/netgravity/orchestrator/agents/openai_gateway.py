"""OpenAI Responses transport for evidence-only dashboard explanations."""
from __future__ import annotations

import os
import time
from types import SimpleNamespace

from netgravity.orchestrator.agents.llm_gateway import LLMResponse, LLMUsage
from netgravity.orchestrator.exceptions import LLMFailureError
from netgravity.telemetry import record_call


class OpenAIResponsesGateway:
    def __init__(self):
        self.config = SimpleNamespace(
            token=os.environ.get("OPENAI_API_KEY", "").strip(),
            model_name=os.environ.get("OPENAI_MODEL", "gpt-5.6-luna").strip(),
            base_url="https://api.openai.com/v1",
        )
        self.calls = 0

    @property
    def available(self):
        return bool(self.config.token) and os.environ.get("NETGRAVITY_DISABLE_LLM", "").lower() not in {"1", "true", "yes"}

    def unavailable_reason(self):
        return "OpenAI credentials are unavailable or AI is disabled. Calculated results remain available."

    def begin_execution(self):
        pass

    def generate(self, prompt, *, purpose="explanation"):
        if not self.available:
            raise LLMFailureError(self.unavailable_reason())
        import requests
        started = time.perf_counter()
        try:
            response = requests.post(
                self.config.base_url + "/responses",
                headers={"Authorization": "Bearer " + self.config.token},
                json={"model": self.config.model_name, "input": prompt,
                      "reasoning": {"effort": "low"}, "max_output_tokens": 5000,
                      "store": False}, timeout=(10, 55),
            )
            if response.status_code != 200:
                # Provider bodies may contain customer text. Never echo them.
                raise LLMFailureError(f"OpenAI request failed with HTTP {response.status_code}.")
            body = response.json()
        except (requests.RequestException, ValueError) as exc:
            raise LLMFailureError("OpenAI request failed; no generated advice is available.") from exc
        if body.get("status") != "completed":
            raise LLMFailureError("OpenAI response was incomplete; no generated advice is available.")
        output = "\n".join(part["text"] for item in body.get("output", [])
                           if item.get("type") == "message" for part in item.get("content", [])
                           if part.get("type") == "output_text" and isinstance(part.get("text"), str))
        if not output:
            raise LLMFailureError("OpenAI returned no explanation text.")
        usage = LLMUsage(**{key: int((body.get("usage") or {}).get(key, 0))
                            for key in ("input_tokens", "output_tokens", "total_tokens")})
        self.calls += 1
        model = str(body.get("model") or self.config.model_name)
        record_call(task=f"dashboard:{purpose}", model=model,
                    usage={"prompt_tokens": usage.input_tokens, "completion_tokens": usage.output_tokens,
                           "total_tokens": usage.total_tokens})
        return LLMResponse(output=output, request_id=body.get("id"), usage=usage,
                           latency_seconds=time.perf_counter() - started, model_name=model)

    def stats(self):
        return {"available": self.available, "requests_made": self.calls,
                "model": self.config.model_name, "base_url": self.config.base_url,
                "token_configured": bool(self.config.token), "provider": "openai"}
