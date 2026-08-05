"""Safe, local PDF text extraction for KnowledgeOS ingestion.

The bridge deliberately does not OCR, decrypt, or repair PDF files.  It returns
a structured result for known extraction failures so the Core can stop before a
module sends empty or untrustworthy content to an AI workflow.
"""

import json
import sys
from datetime import datetime, timezone


def argument(name, default):
    try:
        return sys.argv[sys.argv.index(name) + 1]
    except (ValueError, IndexError):
        return default


source = sys.argv[1]
max_pages = max(1, int(argument("--max-pages", "200")))
max_text_chars = max(1, int(argument("--max-text-chars", "500000")))
max_page_text_chars = max(1, int(argument("--max-page-text-chars", "50000")))
extracted_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

try:
    from pypdf import PdfReader, __version__ as extractor_version
    try:
        from pypdf.errors import PdfReadError
    except ImportError:  # Defensive support for older pypdf releases.
        PdfReadError = Exception
except ImportError:
    PdfReader = None
    extractor_version = None
    PdfReadError = Exception


def response(status, *, page_count=0, pages=None, warnings=None, text=""):
    pages = pages or []
    warnings = warnings or []
    text_pages = sum(1 for page in pages if page["text"])
    empty_pages = [page["page"] for page in pages if not page["text"]]
    return {
        "text": text,
        "metadata": {
            "adapter": "pdf-sidecar",
            "pages": page_count,
            "extraction": {
                "status": status,
                "method": "local-text",
                "extractor": "pypdf" if extractor_version else None,
                "extractor_version": extractor_version,
                "extracted_at": extracted_at,
                "text_pages": text_pages,
                "empty_pages": empty_pages,
                "page_text": pages,
                "limits": {
                    "max_pages": max_pages,
                    "max_text_chars": max_text_chars,
                    "max_page_text_chars": max_page_text_chars,
                },
                "warnings": warnings,
            },
        },
    }


if PdfReader is None:
    print(json.dumps(response("unsupported", warnings=["pypdf-not-installed"]), ensure_ascii=False))
    raise SystemExit(0)

try:
    reader = PdfReader(source)
except (PdfReadError, OSError, ValueError) as error:
    print(json.dumps(response("corrupted", warnings=[f"pdf-read-error:{type(error).__name__}"]), ensure_ascii=False))
    raise SystemExit(0)
except Exception as error:  # Do not let one malformed asset break the Inbox cycle.
    print(json.dumps(response("failed", warnings=[f"pdf-open-error:{type(error).__name__}"]), ensure_ascii=False))
    raise SystemExit(0)

if reader.is_encrypted:
    print(json.dumps(response("encrypted", warnings=["encrypted-pdf-requires-user-action"]), ensure_ascii=False))
    raise SystemExit(0)

try:
    page_count = len(reader.pages)
except Exception as error:
    print(json.dumps(response("corrupted", warnings=[f"pdf-page-count-error:{type(error).__name__}"]), ensure_ascii=False))
    raise SystemExit(0)

pages = []
warnings = []
total_chars = 0
for page_number, page in enumerate(reader.pages, start=1):
    if page_number > max_pages:
        warnings.append("page-limit-reached")
        break
    try:
        page_text = page.extract_text() or ""
    except Exception as error:
        page_text = ""
        warnings.append(f"page-{page_number}-extract-error:{type(error).__name__}")
    if len(page_text) > max_page_text_chars:
        page_text = page_text[:max_page_text_chars]
        warnings.append(f"page-{page_number}-text-truncated")
    remaining = max_text_chars - total_chars
    if remaining <= 0:
        warnings.append("text-limit-reached")
        break
    if len(page_text) > remaining:
        page_text = page_text[:remaining]
        warnings.append(f"page-{page_number}-text-truncated-total-limit")
    total_chars += len(page_text)
    pages.append({"page": page_number, "text": page_text, "characters": len(page_text)})
    if total_chars >= max_text_chars:
        warnings.append("text-limit-reached")
        break

if page_count == 0:
    status = "empty"
elif not any(page["text"].strip() for page in pages):
    status = "scanned"
elif warnings or len(pages) < page_count:
    status = "partial"
else:
    status = "completed"

text = "\n\n".join(f"--- Page {page['page']} ---\n{page['text']}" for page in pages if page["text"])
print(json.dumps(response(status, page_count=page_count, pages=pages, warnings=warnings, text=text), ensure_ascii=False))
