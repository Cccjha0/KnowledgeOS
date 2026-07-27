from pathlib import Path
import argparse
import json
import sys
import yaml
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ENGINE_ROOT = Path(__file__).resolve().parents[1]

parser = argparse.ArgumentParser(description="Validate KnowledgeOS engine and Vault fixtures.")
parser.add_argument(
    "--vault",
    type=Path,
    default=ENGINE_ROOT.parent / "knowledgeos-vault",
    help="Path to the Obsidian Vault repository.",
)
args = parser.parse_args()
VAULT_ROOT = args.vault.resolve()

schema_paths = list((ENGINE_ROOT / "core/schemas").rglob("*.schema.json"))
schema_paths += list((ENGINE_ROOT / "modules").rglob("*.schema.json"))
schemas = {}

for path in schema_paths:
    schema = json.loads(path.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    schemas[schema["$id"]] = schema

registry = Registry()
for schema_id, schema in schemas.items():
    registry = registry.with_resource(
        schema_id,
        Resource.from_contents(schema)
    )

def validate(schema_id, data, label):
    schema = schemas[schema_id]
    validator = Draft202012Validator(
        schema,
        registry=registry,
        format_checker=FormatChecker()
    )
    errors = sorted(
        validator.iter_errors(data),
        key=lambda error: list(error.path)
    )

    if errors:
        print(f"[FAIL] {label}")
        for error in errors:
            location = ".".join(str(part) for part in error.path) or "<root>"
            print(f"  - {location}: {error.message}")
        return False

    print(f"[OK]   {label}")
    return True

ok = True

module_manifest = yaml.safe_load(
    (ENGINE_ROOT / "modules/application-tracker/module.yaml")
    .read_text(encoding="utf-8")
)
ok &= validate(
    "https://pkb.local/schemas/core/module-manifest.schema.json",
    module_manifest,
    "application-tracker/module.yaml"
)

instance = yaml.safe_load(
    (VAULT_ROOT / "90-System/Instances/australia-masters-2027/instance.yaml")
    .read_text(encoding="utf-8")
)
ok &= validate(
    "https://pkb.local/schemas/application-tracker/application-instance.schema.json",
    instance,
    "australia-masters-2027/instance.yaml"
)

record = json.loads(
    (ENGINE_ROOT / "examples/monash-application-record.json")
    .read_text(encoding="utf-8")
)
ok &= validate(
    "https://pkb.local/schemas/application-tracker/application-record.schema.json",
    record,
    "examples/monash-application-record.json"
)

report = json.loads(
    (ENGINE_ROOT / "examples/monash-research-report.json")
    .read_text(encoding="utf-8")
)
ok &= validate(
    "https://pkb.local/schemas/application-tracker/research-report.schema.json",
    report,
    "examples/monash-research-report.json"
)

result = json.loads(
    (ENGINE_ROOT / "examples/monash-no-change.update-result.json")
    .read_text(encoding="utf-8")
)
ok &= validate(
    "https://pkb.local/schemas/application-tracker/update-result.schema.json",
    result,
    "examples/monash-no-change.update-result.json"
)

decision = json.loads(
    (ENGINE_ROOT / "examples/review-decision.json")
    .read_text(encoding="utf-8")
)
ok &= validate(
    "https://pkb.local/schemas/core/review-decision.schema.json",
    decision,
    "examples/review-decision.json"
)

run_log = json.loads(
    (ENGINE_ROOT / "examples/run-log.json")
    .read_text(encoding="utf-8")
)
ok &= validate(
    "https://pkb.local/schemas/core/run-log.schema.json",
    run_log,
    "examples/run-log.json"
)

application_document = json.loads(
    (ENGINE_ROOT / "examples/application-document.json").read_text(encoding="utf-8")
)
ok &= validate(
    "https://pkb.local/schemas/application-tracker/application-document.schema.json",
    application_document,
    "examples/application-document.json"
)

research_request = json.loads(
    (ENGINE_ROOT / "examples/research-request.json").read_text(encoding="utf-8")
)
ok &= validate(
    "https://pkb.local/schemas/application-tracker/research-request.schema.json",
    research_request,
    "examples/research-request.json"
)

sys.exit(0 if ok else 1)
