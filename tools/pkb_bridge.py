#!/usr/bin/env python3
from pathlib import Path
import json
import sys
import yaml
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource


def fail(message: str, details=None, code: int = 2):
    payload = {"ok": False, "message": message}
    if details is not None:
        payload["details"] = details
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(code)


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
    data = yaml.safe_load(raw) or {}
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
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        print(json.dumps(data, ensure_ascii=False))
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
