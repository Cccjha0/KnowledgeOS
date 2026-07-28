#!/usr/bin/env python3
from pathlib import Path
import hashlib
import json
import sys
import zipfile


def fail(message, code=2):
    print(json.dumps({"ok": False, "message": message}, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(code)


def safe_members(archive):
    for member in archive.infolist():
        name = member.filename.replace("\\", "/")
        if name.startswith("/") or ".." in Path(name).parts or ":" in name.split("/")[0]:
            fail(f"Unsafe package member: {member.filename}")
        yield member


def main():
    if len(sys.argv) < 4:
        fail("Expected command, source, and destination")
    command, source_text, destination_text = sys.argv[1:4]
    source, destination = Path(source_text), Path(destination_text)
    if command == "pack":
        destination.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for file in sorted(path for path in source.rglob("*") if path.is_file()):
                relative = file.relative_to(source).as_posix()
                info = zipfile.ZipInfo(relative, (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                archive.writestr(info, file.read_bytes())
        digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        print(json.dumps({"ok": True, "sha256": digest, "files": len(zipfile.ZipFile(destination).infolist())}))
        return
    if command == "unpack":
        destination.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(source, "r") as archive:
            members = list(safe_members(archive))
            archive.extractall(destination, members=members)
        print(json.dumps({"ok": True, "files": len(members), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}))
        return
    fail(f"Unknown command: {command}")


if __name__ == "__main__":
    main()
