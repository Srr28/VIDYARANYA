import re

from PyPDF2 import PdfReader
from docx import Document
from pdf2image import convert_from_path
from PIL import Image
import pytesseract


def _clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def extract_text(file_path: str, mime_type: str) -> str:
    mime = (mime_type or "").lower()
    extracted_text = ""

    if "pdf" in mime:
        try:
            reader = PdfReader(file_path)
            extracted_text = "\n".join((page.extract_text() or "") for page in reader.pages)
        except Exception:
            extracted_text = ""

        if len(_clean_text(extracted_text)) < 100:
            images = convert_from_path(file_path, dpi=300)
            ocr_text = []
            for image in images:
                ocr_text.append(pytesseract.image_to_string(image, lang="eng"))
            extracted_text = "\n".join(ocr_text)

    elif "word" in mime or "docx" in mime:
        document = Document(file_path)
        extracted_text = "\n".join(paragraph.text for paragraph in document.paragraphs)

    elif "image" in mime or any(ext in mime for ext in ["jpeg", "jpg", "png"]):
        with Image.open(file_path) as image:
            extracted_text = pytesseract.image_to_string(image, lang="eng")

    elif mime.startswith("text/") or "plain" in mime:
        try:
            with open(file_path, "r", encoding="utf-8", errors="ignore") as text_file:
                extracted_text = text_file.read()
        except Exception:
            extracted_text = ""

    return _clean_text(extracted_text)
