import io
import logging
import os
import re
import shutil
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from PIL import Image

try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None

try:
    from docx import Document
except ImportError:
    Document = None

try:
    import pytesseract
except ImportError:
    pytesseract = None

logger = logging.getLogger(__name__)

if pytesseract is not None:
    tesseract_cmd = os.getenv("TESSERACT_CMD") or shutil.which("tesseract")
    if not tesseract_cmd and os.name == "nt":
        windows_tesseract = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Tesseract-OCR" / "tesseract.exe"
        if windows_tesseract.is_file():
            tesseract_cmd = str(windows_tesseract)
    if tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = tesseract_cmd


def normalize_text(text: str) -> str:
    """
    Standardize text formatting:
    - Normalize line breaks and remove form feeds
    - Collapse 3+ newlines to 2 (preserving paragraph structure)
    - Collapse multiple spaces and tabs to a single space
    """
    if not text:
        return ""

    # Replace carriage returns and form feeds
    cleaned = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x0c", "\n")

    # Clean horizontal whitespace per line
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in cleaned.split("\n")]
    cleaned = "\n".join(lines)

    # Collapse excessive vertical whitespace to 2 newlines (paragraph boundary)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _extract_pdf_fitz(doc) -> str:
    """
    Extract text page-by-page using PyMuPDF.
    OCR sparse pages and preserve existing PDF text when both extraction paths find content.
    """
    page_texts: list[str] = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        raw_text = page.get_text("text") or ""
        words = raw_text.split()

        # Use OCR for scanned/sparse pages, but don't discard PDF text already
        # extracted successfully. Mixed pages can contain digital text plus
        # diagrams or equations that OCR may only partially recognize.
        if len(words) < 50:
            try:
                pix = page.get_pixmap(dpi=300)
                img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                ocr_text = pytesseract.image_to_string(img, lang="eng").strip()
                ocr_words = ocr_text.split()
                if not words and ocr_words:
                    page_texts.append(ocr_text)
                elif len(words) < 50 and len(ocr_words) > max(60, int(len(words) * 1.5)):
                    # Sparse PDF text may only be a header while the main page
                    # is scanned. Keep both sources so OCR cannot erase text.
                    page_texts.append(f"{raw_text.strip()}\n\n{ocr_text}".strip())
                else:
                    page_texts.append(raw_text)
            except Exception as exc:
                logger.warning("PDF OCR failed on page %d: %s", page_num + 1, exc)
                page_texts.append(raw_text)
        else:
            page_texts.append(raw_text)

    return "\n\n".join(page_texts)


def _extract_office_xml(data: bytes, suffix: str) -> str:
    """Extract readable text from PowerPoint and Excel Open XML files."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = archive.namelist()
            if suffix == ".pptx":
                slide_names = sorted(
                    (name for name in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
                    key=lambda name: int(re.search(r"slide(\d+)", name).group(1)),
                )
                slides = []
                for name in slide_names:
                    root = ET.fromstring(archive.read(name))
                    text = [node.text or "" for node in root.iter() if node.tag.endswith("}t")]
                    slide = " ".join(part.strip() for part in text if part.strip())
                    if slide:
                        slides.append(slide)
                return "\n\n".join(slides)

            if suffix == ".xlsx":
                shared = []
                if "xl/sharedStrings.xml" in names:
                    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
                    shared = [
                        "".join(node.text or "" for node in item.iter() if node.tag.endswith("}t"))
                        for item in root
                    ]
                sheets = sorted(
                    (name for name in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name)),
                    key=lambda name: int(re.search(r"sheet(\d+)", name).group(1)),
                )
                rows = []
                for name in sheets:
                    root = ET.fromstring(archive.read(name))
                    for row in (node for node in root.iter() if node.tag.endswith("}row")):
                        values = []
                        for cell in (node for node in row if node.tag.endswith("}c")):
                            value = next((node.text for node in cell if node.tag.endswith("}v")), "") or ""
                            if cell.attrib.get("t") == "s" and value.isdigit():
                                index = int(value)
                                value = shared[index] if index < len(shared) else ""
                            elif cell.attrib.get("t") == "inlineStr":
                                value = " ".join(node.text or "" for node in cell.iter() if node.tag.endswith("}t"))
                            if value.strip():
                                values.append(value.strip())
                        if values:
                            rows.append(" | ".join(values))
                return "\n".join(rows)
    except (OSError, KeyError, ValueError, ET.ParseError, zipfile.BadZipFile):
        return ""
    return ""


def extract_text(file_path: str, mime_type: str = "") -> str:
    """
    Extract text from a file on disk (PDF, DOCX, Images, Plain Text).
    """
    path = Path(file_path)
    if not path.is_file():
        return ""

    mime = (mime_type or "").lower()
    suffix = path.suffix.lower()

    is_pdf = "pdf" in mime or suffix == ".pdf"
    is_docx = "word" in mime or "docx" in mime or suffix == ".docx"
    is_image = "image" in mime or suffix in [".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".webp"]
    is_text = mime.startswith("text/") or "plain" in mime or suffix in [".txt", ".md", ".csv", ".json"]

    extracted_text = ""

    if is_pdf:
        if fitz is not None:
            try:
                with fitz.open(file_path) as doc:
                    extracted_text = _extract_pdf_fitz(doc)
            except Exception:
                extracted_text = ""
        else:
            # Fallback if PyMuPDF is not installed
            try:
                from PyPDF2 import PdfReader
                reader = PdfReader(file_path)
                extracted_text = "\n".join((p.extract_text() or "") for p in reader.pages)
            except Exception:
                extracted_text = ""

    elif is_docx:
        if Document is not None:
            try:
                document = Document(file_path)
                parts = [p.text for p in document.paragraphs if p.text.strip()]
                for table in document.tables:
                    for row in table.rows:
                        row_text = " | ".join(cell.text.strip() for cell in row.cells if cell.text.strip())
                        if row_text:
                            parts.append(row_text)
                extracted_text = "\n\n".join(parts)
            except Exception:
                extracted_text = ""

    elif is_image:
        try:
            with Image.open(file_path) as image:
                extracted_text = pytesseract.image_to_string(image, lang="eng")
        except Exception:
            extracted_text = ""

    elif is_text or not mime:
        try:
            extracted_text = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            extracted_text = ""

    return normalize_text(extracted_text)


def extract_text_from_bytes(data: bytes, mime_type: str = "", filename: str = "") -> str:
    """
    Extract text directly from bytes (for direct streaming or R2 ingestion).
    """
    if not data:
        return ""

    mime = (mime_type or "").lower()
    suffix = Path(filename).suffix.lower() if filename else ""

    is_pdf = "pdf" in mime or suffix == ".pdf"
    is_docx = "word" in mime or "docx" in mime or suffix == ".docx"
    is_office_xml = suffix in {".pptx", ".xlsx"}
    is_image = "image" in mime or suffix in [".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".webp"]
    is_text = mime.startswith("text/") or "plain" in mime or suffix in [".txt", ".md", ".csv", ".json"]

    extracted_text = ""

    if is_pdf:
        if fitz is not None:
            try:
                with fitz.open(stream=data, filetype="pdf") as doc:
                    extracted_text = _extract_pdf_fitz(doc)
            except Exception:
                extracted_text = ""
        else:
            try:
                from PyPDF2 import PdfReader
                reader = PdfReader(io.BytesIO(data))
                extracted_text = "\n".join((p.extract_text() or "") for p in reader.pages)
            except Exception:
                extracted_text = ""

    elif is_docx:
        if Document is not None:
            try:
                document = Document(io.BytesIO(data))
                parts = [p.text for p in document.paragraphs if p.text.strip()]
                for table in document.tables:
                    for row in table.rows:
                        row_text = " | ".join(cell.text.strip() for cell in row.cells if cell.text.strip())
                        if row_text:
                            parts.append(row_text)
                extracted_text = "\n\n".join(parts)
            except Exception:
                extracted_text = ""

    elif is_office_xml:
        extracted_text = _extract_office_xml(data, suffix)

    elif is_image:
        try:
            with Image.open(io.BytesIO(data)) as image:
                extracted_text = pytesseract.image_to_string(image, lang="eng")
        except Exception:
            extracted_text = ""

    elif is_text or not mime:
        try:
            extracted_text = data.decode("utf-8", errors="ignore")
        except Exception:
            extracted_text = ""

    return normalize_text(extracted_text)
