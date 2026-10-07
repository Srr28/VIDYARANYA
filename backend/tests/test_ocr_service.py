import tempfile
from pathlib import Path

from app.services.ocr_service import (
    extract_text,
    extract_text_from_bytes,
    normalize_text,
)

try:
    import fitz
except ImportError:
    fitz = None


def test_normalize_text():
    dirty = "Hello   world!\r\n\r\n\r\nThis is a   new paragraph.\x0cPage break."
    cleaned = normalize_text(dirty)
    assert "Hello world!" in cleaned
    assert "This is a new paragraph." in cleaned
    assert "Page break." in cleaned
    assert "\r" not in cleaned
    assert "\x0c" not in cleaned
    # Ensure paragraphs are separated by double newline
    assert "Hello world!\n\nThis is a new paragraph." in cleaned


def test_extract_text_plain():
    content = b"Sample plain text content for testing extraction.\nSecond line here."
    result = extract_text_from_bytes(content, mime_type="text/plain", filename="sample.txt")
    assert "Sample plain text content for testing extraction." in result
    assert "Second line here." in result


def test_extract_text_from_temp_file():
    with tempfile.NamedTemporaryFile("w+", suffix=".txt", delete=False) as f:
        f.write("Line 1 of note\n\nLine 2 of note")
        f.flush()
        temp_name = f.name

    try:
        extracted = extract_text(temp_name, mime_type="text/plain")
        assert "Line 1 of note" in extracted
        assert "Line 2 of note" in extracted
    finally:
        Path(temp_name).unlink(missing_ok=True)


def test_pymupdf_pdf_extraction():
    if fitz is None:
        return

    # Create a synthetic PDF document in memory using PyMuPDF
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((50, 72), "VIDYARANYA Academic Assessment Engine\nBinary Trees and Graph Traversal", fontsize=14)
    pdf_bytes = doc.tobytes()
    doc.close()

    extracted = extract_text_from_bytes(pdf_bytes, mime_type="application/pdf", filename="test.pdf")
    assert "VIDYARANYA Academic Assessment Engine" in extracted
    assert "Binary Trees and Graph Traversal" in extracted
