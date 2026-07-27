from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import argparse
import json
import os
import shutil
import sys
import zipfile

MANIFEST = "_knowledgeos_backup_manifest.json"


def digest(data: bytes) -> str:
    return sha256(data).hexdigest()


def excluded(relative: Path) -> bool:
    parts = relative.parts
    return (
        not parts
        or parts[0] == ".git"
        or parts[:2] == ("90-System", "Cache")
        or parts[:3] == ("90-System", "State", "Locks")
        or any(part.startswith(".tmp-") or ".tmp-" in part for part in parts)
    )


def create(vault: Path, destination: Path) -> dict:
    vault = vault.resolve()
    destination = destination.resolve()
    try:
        destination.relative_to(vault)
        raise ValueError("Backup destination must be outside the Vault")
    except ValueError as error:
        if str(error) == "Backup destination must be outside the Vault":
            raise
    if destination.suffix.lower() != ".zip":
        destination.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        destination = destination / f"KnowledgeOS-Vault-{stamp}.zip"
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
    lock = vault / "90-System" / "State" / "Locks" / "operation-plan.lock.json"
    lock.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise ValueError("Vault is busy or has a stale execution lock; run transaction recover first")
    try:
        os.write(descriptor, json.dumps({"pid": os.getpid(), "operation": "backup"}).encode("utf-8"))
        os.close(descriptor)
        files = []
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for file in sorted(vault.rglob("*")):
                if not file.is_file():
                    continue
                relative = file.relative_to(vault)
                if excluded(relative):
                    continue
                data = file.read_bytes()
                name = relative.as_posix()
                archive.writestr(name, data)
                files.append({"path": name, "size": len(data), "sha256": digest(data)})
            manifest = {
                "format": "knowledgeos-vault-backup",
                "format_version": 1,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "includes_configuration": True,
                "includes_user_data": True,
                "includes_runtime_state": True,
                "includes_attachments": True,
                "excluded": [".git", "90-System/Cache", "90-System/State/Locks", "temporary files"],
                "files": files,
            }
            archive.writestr(MANIFEST, json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
    finally:
        lock.unlink(missing_ok=True)
    return {"status": "created", "archive": str(destination), "files": len(files), "sha256": digest(destination.read_bytes())}


def verify(archive_path: Path) -> dict:
    archive_path = archive_path.resolve()
    errors = []
    with zipfile.ZipFile(archive_path, "r") as archive:
        manifest = json.loads(archive.read(MANIFEST))
        for item in manifest["files"]:
            try:
                data = archive.read(item["path"])
            except KeyError:
                errors.append(f"missing: {item['path']}")
                continue
            if len(data) != item["size"] or digest(data) != item["sha256"]:
                errors.append(f"checksum mismatch: {item['path']}")
    if errors:
        raise ValueError("; ".join(errors))
    return {"status": "valid", "archive": str(archive_path), "files": len(manifest["files"]), "sha256": digest(archive_path.read_bytes())}


def restore(archive_path: Path, target: Path) -> dict:
    verify(archive_path)
    target = target.resolve()
    if target.exists() and any(target.iterdir()):
        raise ValueError("Restore target must be empty or absent")
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive_path.resolve(), "r") as archive:
        for member in archive.infolist():
            if member.filename == MANIFEST:
                continue
            destination = (target / member.filename).resolve()
            destination.relative_to(target)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as source, destination.open("wb") as output:
                shutil.copyfileobj(source, output)
    return {"status": "restored", "archive": str(archive_path.resolve()), "target": str(target)}


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    create_parser = sub.add_parser("create")
    create_parser.add_argument("--vault", type=Path, required=True)
    create_parser.add_argument("--destination", type=Path, required=True)
    verify_parser = sub.add_parser("verify")
    verify_parser.add_argument("--archive", type=Path, required=True)
    restore_parser = sub.add_parser("restore")
    restore_parser.add_argument("--archive", type=Path, required=True)
    restore_parser.add_argument("--target", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "create": result = create(args.vault, args.destination)
        elif args.command == "verify": result = verify(args.archive)
        else: result = restore(args.archive, args.target)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"status": "error", "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
