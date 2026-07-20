"""Generate strict Pydantic models from the canonical OpenAPI components."""

from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
INPUT = ROOT / "packages" / "contracts" / "generated" / "openapi-components.json"
OUTPUT = (
    ROOT / "connectors" / "litellm" / "src" / "ai_control_litellm" / "generated" / "contracts.py"
)
UUID_PATTERN = (
    "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-"
    "[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-"
    "000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
)


def replace_constrained_strings(source: str) -> str:
    """Convert generated constr calls, including regexes with nested parentheses."""

    marker = "constr("
    chunks: list[str] = []
    cursor = 0
    while (start := source.find(marker, cursor)) >= 0:
        chunks.append(source[cursor:start])
        depth = 1
        end = start + len(marker)
        while end < len(source) and depth > 0:
            if source[end] == "(":
                depth += 1
            elif source[end] == ")":
                depth -= 1
            end += 1
        if depth != 0:
            raise ValueError("Unbalanced generated constr call")
        arguments = source[start + len(marker) : end - 1]
        chunks.append(f"Annotated[str, StringConstraints({arguments})]")
        cursor = end
    chunks.append(source[cursor:])
    return "".join(chunks)


def make_generated_models_type_checker_safe() -> None:
    """Normalize constrained keys and MISSING defaults for static tooling."""

    source = OUTPUT.read_text(encoding="utf-8")
    source = source.replace(
        "#   filename:  openapi-components.json\n",
        "#   filename:  openapi-components.json\n# mypy: disable-error-code=assignment\n",
        1,
    )
    source = source.replace("    constr,\n", "    StringConstraints,\n")
    source = replace_constrained_strings(source)
    for inner_indent in ("    ", "        "):
        outer_indent = inner_indent[:-4]
        incompatible_uuid_constraint = (
            "Annotated[\n"
            f"{inner_indent}UUID,\n"
            f"{inner_indent}Field(\n"
            f'{inner_indent}    pattern="{UUID_PATTERN}"\n'
            f"{inner_indent}),\n"
            f"{outer_indent}]"
        )
        source = source.replace(incompatible_uuid_constraint, "UUID")
    source = source.replace(" | MISSING", "")
    source = source.replace(
        "from enum import StrEnum\n", "from enum import StrEnum\nfrom math import isfinite\n"
    )
    source = source.replace("    StrictInt,\n", "    BeforeValidator,\n")
    source = source.replace("StrictInt", "JsonInteger")
    source = source.replace(
        "from pydantic.experimental.missing_sentinel import MISSING\n",
        "from pydantic.experimental.missing_sentinel import MISSING\n\n\n"
        "def _validate_json_integer(value: object) -> int:\n"
        "    if isinstance(value, bool) or not isinstance(value, (int, float)):\n"
        '        raise ValueError("expected a JSON integer")\n'
        "    if isinstance(value, float) and (not isfinite(value) or not value.is_integer()):\n"
        '        raise ValueError("expected a JSON integer")\n'
        "    return int(value)\n\n\n"
        "type JsonInteger = Annotated[int, BeforeValidator(_validate_json_integer)]\n",
        1,
    )
    OUTPUT.write_text(source, encoding="utf-8")

    subprocess.run(["ruff", "format", str(OUTPUT)], check=True, cwd=ROOT)
    subprocess.run(["ruff", "check", "--fix", str(OUTPUT)], check=True, cwd=ROOT)


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "datamodel-codegen",
            "--input",
            str(INPUT),
            "--input-file-type",
            "openapi",
            "--openapi-scopes",
            "schemas",
            "--output",
            str(OUTPUT),
            "--output-model-type",
            "pydantic_v2.BaseModel",
            "--target-python-version",
            "3.12",
            "--use-standard-collections",
            "--use-union-operator",
            "--strict-nullable",
            "--use-default",
            "--set-default-enum-member",
            "--disable-timestamp",
            "--extra-fields",
            "forbid",
            "--field-constraints",
            "--use-annotated",
            "--strict-types",
            "str",
            "int",
            "float",
            "bool",
            "--use-type-alias",
            "--use-missing-sentinel",
            "--capitalise-enum-members",
            "--formatters",
            "ruff-check",
            "ruff-format",
        ],
        check=True,
        cwd=ROOT,
    )
    make_generated_models_type_checker_safe()


if __name__ == "__main__":
    main()
