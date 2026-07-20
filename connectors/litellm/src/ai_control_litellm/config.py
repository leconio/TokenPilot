"""Environment-backed connector configuration with secret-safe representations."""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_CONTROL_PLANE_URL = "http://127.0.0.1:4000"


def _positive_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def _positive_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be a number") from error
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def _boolean(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean")


@dataclass(frozen=True, slots=True)
class ConnectorConfig:
    """Runtime settings for capture, durable buffering, upload, and heartbeat."""

    control_plane_url: str = DEFAULT_CONTROL_PLANE_URL
    api_key: str | None = field(default=None, repr=False)
    policy_api_key: str | None = field(default=None, repr=False)
    instance_id: str = field(default_factory=socket.gethostname)
    spool_path: Path = field(default_factory=lambda: Path(".tokenpilot/litellm-spool.sqlite3"))
    batch_size: int = 100
    flush_interval_seconds: float = 1.0
    request_timeout_seconds: float = 10.0
    retry_base_seconds: float = 1.0
    retry_max_seconds: float = 300.0
    lease_seconds: float = 60.0
    heartbeat_interval_seconds: float = 30.0
    policy_poll_interval_seconds: float = 30.0
    policy_lkg_path: Path = field(default_factory=lambda: Path(".tokenpilot/runtime-snapshot.json"))
    policy_required: bool = True
    quota_enabled: bool = True
    quota_fail_closed: bool = True
    reservation_aiu_micros: int = 1_000_000
    max_spool_bytes: int = 512 * 1024 * 1024
    connector_version: str = "0.2.0"
    sender_enabled: bool = True

    def __post_init__(self) -> None:
        parsed = urlparse(self.control_plane_url)
        if parsed.scheme not in {"http", "https"} or parsed.netloc == "":
            raise ValueError("control_plane_url must be an absolute HTTP(S) URL")
        if not self.instance_id or len(self.instance_id) > 256:
            raise ValueError("instance_id must contain 1-256 characters")
        if self.batch_size <= 0:
            raise ValueError("batch_size must be positive")
        if self.max_spool_bytes <= 0:
            raise ValueError("max_spool_bytes must be positive")

    @classmethod
    def from_environment(cls) -> ConnectorConfig:
        """Read configuration without requiring a remote endpoint to be available."""

        return cls(
            control_plane_url=os.getenv(
                "AI_CONTROL_URL",
                os.getenv("AI_CONTROL_CONTROL_PLANE_URL", DEFAULT_CONTROL_PLANE_URL),
            ).rstrip("/"),
            api_key=os.getenv("AI_CONTROL_API_KEY") or os.getenv("AI_CONTROL_INGEST_API_KEY"),
            policy_api_key=os.getenv("AI_CONTROL_POLICY_API_KEY")
            or os.getenv("AI_CONTROL_RUNTIME_API_KEY"),
            instance_id=os.getenv("AI_CONTROL_CONNECTOR_INSTANCE_ID", socket.gethostname()),
            spool_path=Path(
                os.getenv("AI_CONTROL_SPOOL_PATH", ".tokenpilot/litellm-spool.sqlite3")
            ).expanduser(),
            batch_size=_positive_int("AI_CONTROL_BATCH_SIZE", 100),
            flush_interval_seconds=_positive_float("AI_CONTROL_FLUSH_INTERVAL_SECONDS", 1.0),
            request_timeout_seconds=_positive_float("AI_CONTROL_REQUEST_TIMEOUT_SECONDS", 10.0),
            retry_base_seconds=_positive_float("AI_CONTROL_RETRY_BASE_SECONDS", 1.0),
            retry_max_seconds=_positive_float("AI_CONTROL_RETRY_MAX_SECONDS", 300.0),
            lease_seconds=_positive_float("AI_CONTROL_LEASE_SECONDS", 60.0),
            heartbeat_interval_seconds=_positive_float(
                "AI_CONTROL_HEARTBEAT_INTERVAL_SECONDS", 30.0
            ),
            policy_poll_interval_seconds=_positive_float(
                "AI_CONTROL_POLICY_POLL_INTERVAL_SECONDS", 30.0
            ),
            policy_lkg_path=Path(
                os.getenv("AI_CONTROL_POLICY_LKG_PATH", ".tokenpilot/runtime-snapshot.json")
            ).expanduser(),
            policy_required=_boolean("AI_CONTROL_POLICY_REQUIRED", True),
            quota_enabled=_boolean("AI_CONTROL_QUOTA_ENABLED", True),
            quota_fail_closed=_boolean("AI_CONTROL_QUOTA_FAIL_CLOSED", True),
            reservation_aiu_micros=_positive_int("AI_CONTROL_RESERVATION_AIU_MICROS", 1_000_000),
            max_spool_bytes=_positive_int("AI_CONTROL_MAX_SPOOL_BYTES", 512 * 1024 * 1024),
            sender_enabled=_boolean("AI_CONTROL_SENDER_ENABLED", True),
        )

    @property
    def ingestion_url(self) -> str:
        return f"{self.control_plane_url}/usage-events/batch"

    @property
    def usage_schema_capabilities(self) -> tuple[str, ...]:
        """Machine schema capabilities advertised with the heartbeat request."""

        return ("2.0",)

    @property
    def heartbeat_url(self) -> str:
        return f"{self.control_plane_url}/connectors/heartbeat"

    @property
    def runtime_snapshot_url(self) -> str:
        return f"{self.control_plane_url}/runtime/snapshot"

    @property
    def runtime_acknowledgement_url(self) -> str:
        return f"{self.control_plane_url}/runtime/configuration-acknowledgements"

    @property
    def user_reservation_url(self) -> str:
        return f"{self.control_plane_url}/runtime/users/aiu/reservations"
