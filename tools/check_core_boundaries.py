from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
CORE_ROOTS = [ROOT / "src/core", ROOT / "core/schemas"]
MODULE_SOURCE = ROOT / "src/application"

FORBIDDEN_CORE_TERMS = (
    "Monash",
    "application_open",
    "tuition",
    "english_requirement",
    "program_code",
    "Applications",
    "experience-entry",
    "experience-daily-log",
    "experience-weekly-summary",
    "internship",
)

FORBIDDEN_MODULE_PATTERNS = (
    '"node:fs"',
    '"node:child_process"',
    '"../core/git.js"',
    '"../core/dashboard.js"',
    '"../core/reviews.js"',
    '"../core/operationExecutor.js"',
    "writeMarkdown(",
    "writeJsonAtomic(",
    "createGitSnapshot(",
    "executeOperationPlan(",
)

PUBLIC_SCHEMAS = (
    "module-manifest",
    "instance",
    "capture",
    "match-result",
    "operation-plan",
    "review-item",
    "review-decision",
    "dashboard-item",
    "event",
    "run-log",
)

LEGACY_PUBLIC_FIELDS = (
    '"module_instance"',
    '"source_instance"',
    '"suggested_instance"',
    '"module_hint"',
    '"instance_hint"',
)


def text_files(root: Path):
    for path in root.rglob("*"):
        if path.is_file() and path.suffix in {".ts", ".json"}:
            yield path


errors = []
for root in CORE_ROOTS:
    for path in text_files(root):
        text = path.read_text(encoding="utf-8")
        for term in FORBIDDEN_CORE_TERMS:
            if term in text:
                errors.append(f"core domain leak: {path.relative_to(ROOT)} contains {term!r}")

for path in text_files(MODULE_SOURCE):
    text = path.read_text(encoding="utf-8")
    for pattern in FORBIDDEN_MODULE_PATTERNS:
        if pattern in text:
            errors.append(f"module boundary violation: {path.relative_to(ROOT)} contains {pattern!r}")

schema_root = ROOT / "core/schemas"
for name in PUBLIC_SCHEMAS:
    path = schema_root / f"{name}.schema.json"
    if not path.exists():
        errors.append(f"missing public schema: {path.relative_to(ROOT)}")
        continue
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("$id") != f"https://pkb.local/schemas/core/{name}.schema.json":
        errors.append(f"unexpected schema id: {path.relative_to(ROOT)}")
    raw = json.dumps(data, ensure_ascii=False)
    for field in LEGACY_PUBLIC_FIELDS:
        if field in raw:
            errors.append(f"legacy public field: {path.relative_to(ROOT)} contains {field}")

if errors:
    print("[FAIL] Core/module boundary audit")
    for error in errors:
        print(f"  - {error}")
    sys.exit(1)

print("[OK]   Core/module boundary audit")
print(f"[OK]   {len(PUBLIC_SCHEMAS)} stable public schemas present")
