from pathlib import Path

from fastapi import HTTPException

MAX_UPLOAD_BYTES = 10 * 1024 * 1024

_SIGNATURES = {
    ".pdf": (b"%PDF-",),
    ".png": (b"\x89PNG\r\n\x1a\n",),
    ".jpg": (b"\xff\xd8\xff",),
    ".jpeg": (b"\xff\xd8\xff",),
    ".gif": (b"GIF87a", b"GIF89a"),
    ".tif": (b"II*\x00", b"MM\x00*"),
    ".tiff": (b"II*\x00", b"MM\x00*"),
    ".bmp": (b"BM",),
    ".docx": (b"PK\x03\x04",),
    ".pptx": (b"PK\x03\x04",),
    ".xlsx": (b"PK\x03\x04",),
    ".webp": (b"RIFF",),
}
_TEXT_EXTENSIONS = {
    ".txt", ".md", ".csv", ".json", ".py", ".ipynb", ".html", ".xml", ".yaml", ".yml",
    ".js", ".jsx", ".ts", ".tsx", ".java", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs",
    ".go", ".rs", ".php", ".rb", ".swift", ".kt", ".kts", ".sql", ".sh", ".css",
}


def validate_uploaded_file(filename: str, data: bytes) -> None:
    """Validate upload bytes against the declared file extension, not its MIME header."""
    suffix = Path(filename or "").suffix.lower()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds the 10 MB upload limit")
    if suffix in {".doc", ".xls"}:
        raise HTTPException(
            status_code=415,
            detail="Legacy .doc and .xls files are not extractable. Convert them to .docx or .xlsx and upload again.",
        )

    signatures = _SIGNATURES.get(suffix)
    if signatures:
        if not any(data.startswith(signature) for signature in signatures):
            raise HTTPException(status_code=400, detail=f"File content does not match {suffix or 'the declared type'}")
        if suffix == ".webp" and data[8:12] != b"WEBP":
            raise HTTPException(status_code=400, detail="File content does not match .webp")
        return

    if suffix not in _TEXT_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Unsupported file type")
    try:
        decoded = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="Text file is not valid UTF-8") from exc
    if "\x00" in decoded:
        raise HTTPException(status_code=400, detail="Text file contains binary data")
