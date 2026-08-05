import json
import sys

source = sys.argv[1]
reader = None
try:
    from pypdf import PdfReader
    reader = PdfReader(source)
except ImportError:
    try:
        from PyPDF2 import PdfReader
        reader = PdfReader(source)
    except ImportError:
        print("PDF extraction requires pypdf or PyPDF2.", file=sys.stderr)
        raise SystemExit(2)

text = "\n\n".join((page.extract_text() or "") for page in reader.pages)
print(json.dumps({"text": text, "metadata": {"adapter": "pdf-sidecar", "pages": len(reader.pages), "extraction": "local-text"}}, ensure_ascii=False))
