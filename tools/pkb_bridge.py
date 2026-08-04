#!/usr/bin/env python3
from pathlib import Path
from datetime import date, datetime, time
import json
import sys
import yaml


def fail(message: str, details=None, code: int = 2):
    payload = {"ok": False, "message": message}
    if details is not None:
        payload["details"] = details
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(code)


def json_safe(value):
    """Normalize valid YAML scalar types to the JSON contract used by Core."""
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, set):
        return [json_safe(item) for item in sorted(value, key=str)]
    return value


def parse_frontmatter(text: str):
    if not text.startswith("---"):
        return {}, text
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return {}, text
    end = None
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            end = index
            break
    if end is None:
        fail("Markdown frontmatter is not closed")
    raw = "".join(lines[1:end])
    data = json_safe(yaml.safe_load(raw) or {})
    if not isinstance(data, dict):
        fail("Markdown frontmatter must be a mapping")
    content = "".join(lines[end + 1:])
    return data, content


def dump_markdown(data, content: str):
    yaml_text = yaml.safe_dump(
        data,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
        width=120,
    ).rstrip()
    body = content.lstrip("\n")
    return f"---\n{yaml_text}\n---\n\n{body}"


def load_schemas(engine_root: Path):
    # Markdown and YAML parsing are the hot path for every view and review.
    # Import the considerably heavier schema stack only for validation commands.
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource

    schemas = {}
    for schema_root in (engine_root / "core/schemas", engine_root / "modules"):
        for path in schema_root.rglob("*.schema.json"):
            schema = json.loads(path.read_text(encoding="utf-8"))
            Draft202012Validator.check_schema(schema)
            schemas[schema["$id"]] = schema
    registry = Registry()
    for schema_id, schema in schemas.items():
        registry = registry.with_resource(schema_id, Resource.from_contents(schema))
    return schemas, registry


def main():
    if len(sys.argv) < 2:
        fail("Missing command")
    command = sys.argv[1]

    if command == "parse-markdown":
        path = Path(sys.argv[2])
        data, content = parse_frontmatter(path.read_text(encoding="utf-8"))
        print(json.dumps({"data": data, "content": content}, ensure_ascii=False))
        return

    if command == "write-markdown":
        path = Path(sys.argv[2])
        payload = json.load(sys.stdin)
        path.parent.mkdir(parents=True, exist_ok=True)
        rendered = dump_markdown(payload["data"], payload.get("content", ""))
        surrogate_positions = [
            index for index, character in enumerate(rendered)
            if 0xD800 <= ord(character) <= 0xDFFF
        ]
        if surrogate_positions:
            index = surrogate_positions[0]
            fail(
                "Markdown contains surrogate code points",
                {
                    "positions": surrogate_positions,
                    "context": repr(rendered[max(0, index - 40):index + 40]),
                },
            )
        path.write_text(
            rendered,
            encoding="utf-8",
        )
        print(json.dumps({"ok": True}, ensure_ascii=False))
        return

    if command == "parse-yaml":
        path = Path(sys.argv[2])
        data = json_safe(yaml.safe_load(path.read_text(encoding="utf-8")) or {})
        print(json.dumps(data, ensure_ascii=False))
        return

    if command == "parse-validate-yaml-batch":
        from jsonschema import Draft202012Validator, FormatChecker

        engine_root = Path(sys.argv[2]).resolve()
        payload = json.load(sys.stdin)
        if not isinstance(payload, list):
            fail("Batch payload must be a list")
        schemas, registry = load_schemas(engine_root)
        output = []
        for index, item in enumerate(payload):
            if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not isinstance(item.get("schema_id"), str):
                fail("Batch item must contain path and schema_id", {"index": index})
            path = Path(item["path"])
            schema_id = item["schema_id"]
            if schema_id not in schemas:
                fail(f"Unknown schema: {schema_id}", {"index": index, "path": str(path)})
            data = json_safe(yaml.safe_load(path.read_text(encoding="utf-8")) or {})
            validator = Draft202012Validator(
                schemas[schema_id],
                registry=registry,
                format_checker=FormatChecker(),
            )
            errors = sorted(validator.iter_errors(data), key=lambda error: list(error.path))
            if errors:
                details = []
                for error in errors:
                    location = ".".join(str(part) for part in error.path) or "<root>"
                    details.append({"path": location, "message": error.message})
                fail("Schema validation failed", {"index": index, "file": str(path), "errors": details})
            output.append(data)
        print(json.dumps(output, ensure_ascii=False))
        return

    if command == "write-yaml":
        path = Path(sys.argv[2])
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            fail("YAML document must be a mapping")
        path.parent.mkdir(parents=True, exist_ok=True)
        rendered = yaml.safe_dump(
            payload,
            allow_unicode=True,
            sort_keys=False,
            default_flow_style=False,
            width=120,
        )
        path.write_text(rendered, encoding="utf-8")
        print(json.dumps({"ok": True}, ensure_ascii=False))
        return

    if command == "validate":
        from jsonschema import Draft202012Validator, FormatChecker

        engine_root = Path(sys.argv[2]).resolve()
        schema_id = sys.argv[3]
        data = json.load(sys.stdin)
        schemas, registry = load_schemas(engine_root)
        if schema_id not in schemas:
            fail(f"Unknown schema: {schema_id}")
        validator = Draft202012Validator(
            schemas[schema_id],
            registry=registry,
            format_checker=FormatChecker(),
        )
        errors = sorted(validator.iter_errors(data), key=lambda error: list(error.path))
        if errors:
            details = []
            for error in errors:
                location = ".".join(str(part) for part in error.path) or "<root>"
                details.append({"path": location, "message": error.message})
            fail("Schema validation failed", details)
        print(json.dumps({"ok": True}, ensure_ascii=False))
        return

    fail(f"Unknown command: {command}")


if __name__ == "__main__":
    main()
