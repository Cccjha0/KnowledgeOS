#!/usr/bin/env python3
from pathlib import Path
import argparse
import json
import shutil
import subprocess

ENGINE_ROOT = Path(__file__).resolve().parents[1]


def write_markdown(vault_root: Path, path: Path, data: dict, content: str) -> None:
    result = subprocess.run(
        ["python", "-X", "utf8", str(ENGINE_ROOT / "tools/pkb_bridge.py"), "write-markdown", str(path)],
        input=json.dumps({"data": data, "content": content}, ensure_ascii=False),
        text=True,
        capture_output=True,
        cwd=vault_root,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="Reset the application-tracker demo Vault.")
    parser.add_argument(
        "--vault",
        type=Path,
        default=ENGINE_ROOT.parent / "knowledgeos-vault",
        help="Path to the Obsidian Vault repository.",
    )
    args = parser.parse_args()
    vault_root = args.vault.resolve()
    instance = vault_root / "20-Workspace/Applications/australia-masters-2027"
    record = json.loads((ENGINE_ROOT / "examples/monash-application-record.json").read_text(encoding="utf-8"))
    report = json.loads((ENGINE_ROOT / "examples/monash-research-report.json").read_text(encoding="utf-8"))

    for file_path in (instance / "Inbox").glob("*.md"):
        file_path.unlink()
    for file_path in (instance / "Research").glob("*.md"):
        file_path.unlink()
    for file_path in (vault_root / "90-System/Review Queue/Pending").glob("*.md"):
        file_path.unlink()
    for file_path in (vault_root / "90-System/Logs").glob("*.md"):
        file_path.unlink()

    shutil.rmtree(vault_root / "90-System/State/Plans", ignore_errors=True)
    (vault_root / "90-System/State/processed-reports.json").unlink(missing_ok=True)
    (vault_root / "Today.md").unlink(missing_ok=True)

    write_markdown(
        vault_root,
        instance / "Records/Monash-C6007.md",
        record,
        """# Monash University — Master of Artificial Intelligence

## 当前状态

2027年2月入学申请尚未确认开放。

## 已确认信息

- 课程代码：C6007

## 待核验信息

- 正式开放日期
- 2027年度国际生学费

## 下一步行动

等待下一次官方核验。

## 变更记录

- 2026-07-22：建立初始档案。

## 来源

- [[RPT-2026-000001]]
""",
    )

    write_markdown(
        vault_root,
        instance / "Inbox/2026-07-27-Monash-C6007-Update.md",
        report,
        """# Monash C6007 申请状态核验

## 结论

本次核验未发现申请开放状态发生实质变化。

## 未解决事项

- 正式开放日期
- 2027年度国际生学费

> 本文件用于验证真实文件处理链路；数据来自本地 Fixture，并非本轮联网核验。
""",
    )

    print("Demo data reset.")
    print("Run:")
    print("  node dist/cli.js application process-report 20-Workspace/Applications/australia-masters-2027/Inbox/2026-07-27-Monash-C6007-Update.md --vault ../knowledgeos-vault")


if __name__ == "__main__":
    main()
