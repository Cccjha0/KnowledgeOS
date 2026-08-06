"""Safe local Open XML extraction for PowerPoint attachments.

This deliberately extracts only text, speaker notes, and internal image
references. It never renders slides, follows external links, or mutates the
original presentation.
"""

import json
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET


def argument(name, default):
    try:
        return sys.argv[sys.argv.index(name) + 1]
    except (ValueError, IndexError):
        return default


source = sys.argv[1]
max_slides = max(1, int(argument("--max-slides", "500")))
max_text_chars = max(1, int(argument("--max-text-chars", "500000")))
extracted_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def text_from_xml(payload):
    root = ET.fromstring(payload)
    return "\n".join(node.text.strip() for node in root.iter() if local_name(node.tag) == "t" and node.text and node.text.strip())


def image_refs(archive, slide_number):
    relationship = f"ppt/slides/_rels/slide{slide_number}.xml.rels"
    if relationship not in archive.namelist():
        return []
    root = ET.fromstring(archive.read(relationship))
    refs = []
    for node in root.iter():
        if local_name(node.tag) != "Relationship":
            continue
        target = node.attrib.get("Target", "")
        if "/media/" not in target:
            continue
        resolved = PurePosixPath("ppt/slides") / target
        normalized = str(resolved).replace("ppt/slides/../", "ppt/")
        refs.append(normalized)
    return sorted(set(refs))


def response(status, *, text="", slides=None, warnings=None, count=0):
    slides = slides or []
    return {
        "text": text,
        "metadata": {
            "adapter": "pptx-openxml",
            "slides": count,
            "extraction": {
                "status": status,
                "method": "local-openxml",
                "extractor": "python-zipfile",
                "extracted_at": extracted_at,
                "slide_text": slides,
                "limits": {"max_slides": max_slides, "max_text_chars": max_text_chars},
                "warnings": warnings or [],
            },
        },
    }


try:
    archive = zipfile.ZipFile(source)
except (OSError, zipfile.BadZipFile) as error:
    print(json.dumps(response("corrupted", warnings=[f"pptx-open-error:{type(error).__name__}"]), ensure_ascii=False))
    raise SystemExit(0)

try:
    pattern = re.compile(r"^ppt/slides/slide(\d+)\.xml$")
    slide_paths = sorted(((int(match.group(1)), name) for name in archive.namelist() if (match := pattern.match(name))), key=lambda item: item[0])
    warnings = []
    extracted = []
    total = 0
    for number, slide_path in slide_paths[:max_slides]:
        try:
            slide_text = text_from_xml(archive.read(slide_path))
            notes_path = f"ppt/notesSlides/notesSlide{number}.xml"
            speaker_notes = text_from_xml(archive.read(notes_path)) if notes_path in archive.namelist() else ""
        except ET.ParseError:
            slide_text = ""
            speaker_notes = ""
            warnings.append(f"slide-{number}-xml-invalid")
        combined_length = len(slide_text) + len(speaker_notes)
        remaining = max_text_chars - total
        if remaining <= 0:
            warnings.append("text-limit-reached")
            break
        if combined_length > remaining:
            slide_text = slide_text[:remaining]
            speaker_notes = ""
            warnings.append(f"slide-{number}-text-truncated")
        total += len(slide_text) + len(speaker_notes)
        extracted.append({"slide": number, "text": slide_text, "speaker_notes": speaker_notes, "image_refs": image_refs(archive, number), "characters": len(slide_text)})
    if len(slide_paths) > max_slides:
        warnings.append("slide-limit-reached")
    if not slide_paths:
        status = "empty"
    elif not any(item["text"] or item["speaker_notes"] for item in extracted):
        status = "empty"
    elif warnings or len(extracted) < len(slide_paths):
        status = "partial"
    else:
        status = "completed"
    text = "\n\n".join(f"--- Slide {item['slide']} ---\n{item['text']}" + (f"\n\n--- Speaker Notes ---\n{item['speaker_notes']}" if item["speaker_notes"] else "") for item in extracted if item["text"] or item["speaker_notes"])
    print(json.dumps(response(status, text=text, slides=extracted, warnings=warnings, count=len(slide_paths)), ensure_ascii=False))
except Exception as error:
    print(json.dumps(response("failed", warnings=[f"pptx-extraction-error:{type(error).__name__}"]), ensure_ascii=False))
