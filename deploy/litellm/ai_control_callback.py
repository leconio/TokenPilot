"""Config-local LiteLLM Proxy shim for the initialized Control Plane callback."""

from ai_control_litellm.callback import proxy_handler_instance

__all__ = ["proxy_handler_instance"]
