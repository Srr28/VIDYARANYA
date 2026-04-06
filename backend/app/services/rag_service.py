from pathlib import Path
import hashlib
import re
from uuid import uuid4

import chromadb
import requests
try:
    from sentence_transformers import SentenceTransformer
except Exception:
    SentenceTransformer = None

from app.core.config import settings

class FallbackEmbedder:
    dim = 64

    def encode(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for text in texts:
            digest = hashlib.sha256((text or "").encode("utf-8")).digest()
            vectors.append([digest[i % len(digest)] / 255.0 for i in range(self.dim)])
        return vectors


def _encode_texts(texts: list[str]) -> list[list[float]]:
    encoded = MODEL.encode(texts)
    if hasattr(encoded, "tolist"):
        return encoded.tolist()
    return [list(map(float, row)) for row in encoded]


MODEL = (
    SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    if SentenceTransformer is not None
    else FallbackEmbedder()
)
CHROMA_CLIENT = chromadb.PersistentClient(path=str(Path("./chroma_db")))


def _call_groq_chat(messages: list[dict[str, str]]) -> str | None:
    api_key = (settings.GROQ_API_KEY or "").strip()
    if not api_key:
        return None

    try:
        response = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": settings.GROQ_MODEL,
                "messages": messages,
                "temperature": 0.2,
            },
            timeout=45,
        )
        if response.status_code >= 400:
            return None
        payload = response.json()
        choices = payload.get("choices") if isinstance(payload, dict) else None
        if not choices or not isinstance(choices, list):
            return None
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        content_text = str(content or "").strip()
        return content_text or None
    except Exception:
        return None


def _chunk_text(text: str, chunk_size: int = 512, overlap: int = 50) -> list[str]:
    cleaned = (text or "").strip()
    if not cleaned:
        return []

    chunks: list[str] = []
    start = 0
    while start < len(cleaned):
        end = start + chunk_size
        chunks.append(cleaned[start:end])
        if end >= len(cleaned):
            break
        start = max(end - overlap, 0)
    return chunks


def index_note(course_id: int, text: str, note_id: int | None = None) -> None:
    collection_name = f"course_{course_id}"
    collection = CHROMA_CLIENT.get_or_create_collection(name=collection_name)

    chunks = _chunk_text(text, chunk_size=512, overlap=50)
    if not chunks:
        return

    embeddings = _encode_texts(chunks)
    ids = [f"{course_id}_{uuid4()}_{idx}" for idx, _ in enumerate(chunks)]
    metadata = [
        {
            "source": f"note:{note_id}" if note_id is not None else "note",
            "note_id": note_id,
        }
        for _ in chunks
    ]

    collection.add(
        ids=ids,
        documents=chunks,
        embeddings=embeddings,
        metadatas=metadata,
    )


def delete_note_chunks(course_id: int, note_id: int) -> None:
    collection_name = f"course_{course_id}"
    try:
        collection = CHROMA_CLIENT.get_collection(name=collection_name)
    except Exception:
        return

    try:
        collection.delete(where={"note_id": note_id})
    except Exception:
        # Keep delete-material action resilient even if vector cleanup fails.
        return


def _general_chat(question: str) -> str:
    answer = _call_groq_chat([
        {
            "role": "system",
            "content": (
                "You are Vidyaranya, a helpful AI tutor. "
                "The user is in general chat mode (no material selected). "
                "Clear doubts in a friendly teaching style, with simple steps and brief examples. "
                "Do not sound like an exam evaluator. "
                "If the user is unclear, ask one helpful follow-up question."
            ),
        },
        {"role": "user", "content": question},
    ])
    if answer:
        return answer
    return "General chat is available, but Groq could not be reached right now. Please try again."


def _query_selected_material_chunks(collection, query_embedding: list[list[float]], note_ids: list[int]) -> tuple[list[str], list[dict]]:
    all_documents: list[str] = []
    all_metadatas: list[dict] = []
    seen_docs: set[str] = set()

    for note_id in note_ids:
        result = collection.query(
            query_embeddings=query_embedding,
            n_results=6,
            where={"note_id": note_id},
        )

        documents = result.get("documents", [[]])[0] if result.get("documents") else []
        metadatas = result.get("metadatas", [[]])[0] if result.get("metadatas") else []

        for idx, doc in enumerate(documents):
            normalized = (doc or "").strip()
            if not normalized or normalized in seen_docs:
                continue
            seen_docs.add(normalized)
            all_documents.append(normalized)
            meta = metadatas[idx] if idx < len(metadatas) and isinstance(metadatas[idx], dict) else {"source": f"note:{note_id}", "note_id": note_id}
            all_metadatas.append(meta)

    return all_documents, all_metadatas


def _tokenize(text: str) -> set[str]:
    return {token for token in re.findall(r"[a-z0-9]+", (text or "").lower()) if len(token) > 2}


def _fallback_selected_material_chunks(collection, note_ids: list[int], question: str, max_chunks: int = 8) -> tuple[list[str], list[dict]]:
    question_tokens = _tokenize(question)
    ranked: list[tuple[int, str, dict]] = []

    for note_id in note_ids:
        try:
            payload = collection.get(where={"note_id": note_id}, include=["documents", "metadatas"])
        except Exception:
            continue

        documents = payload.get("documents", []) if isinstance(payload, dict) else []
        metadatas = payload.get("metadatas", []) if isinstance(payload, dict) else []

        for idx, doc in enumerate(documents):
            text = str(doc or "").strip()
            if not text:
                continue
            doc_tokens = _tokenize(text)
            score = len(question_tokens.intersection(doc_tokens))
            meta = metadatas[idx] if idx < len(metadatas) and isinstance(metadatas[idx], dict) else {"source": f"note:{note_id}", "note_id": note_id}
            ranked.append((score, text, meta))

    if not ranked:
        return [], []

    ranked.sort(key=lambda item: item[0], reverse=True)
    selected: list[str] = []
    selected_meta: list[dict] = []
    seen = set()

    for _score, text, meta in ranked:
        if text in seen:
            continue
        seen.add(text)
        selected.append(text)
        selected_meta.append(meta)
        if len(selected) >= max_chunks:
            break

    return selected, selected_meta


def chat(course_id: int, question: str, note_ids: list[int] | None = None) -> dict[str, list[str] | str]:
    selected_note_ids = sorted({note_id for note_id in (note_ids or []) if isinstance(note_id, int) and note_id > 0})

    if not selected_note_ids:
        return {
            "answer": _general_chat(question),
            "sources": [],
        }

    collection_name = f"course_{course_id}"
    try:
        collection = CHROMA_CLIENT.get_collection(name=collection_name)
    except Exception:
        return {
            "answer": "I could not find indexed content for the selected materials. Try selecting different materials or use general chat.",
            "sources": [],
        }

    query_embedding = _encode_texts([question])
    documents, metadatas = _query_selected_material_chunks(collection, query_embedding, selected_note_ids)

    if not documents:
        documents, metadatas = _fallback_selected_material_chunks(collection, selected_note_ids, question)

    if not documents:
        general = _general_chat(question)
        return {
            "answer": (
                "I could not read enough indexed text from the selected materials, so I am giving a general explanation.\n\n"
                f"{general}\n\n"
                "Tip: Upload text-based PDF/DOCX/TXT files for stronger material-grounded answers."
            ),
            "sources": [f"note:{note_id}" for note_id in selected_note_ids],
        }

    context_text = "\n\n".join(documents)
    prompt = (
        "You are Vidyaranya, a helpful AI tutor.\n"
        "The user selected specific course materials.\n"
        "Your job is to clear doubts, not just answer like a strict examiner.\n"
        "Use this response style:\n"
        "1) Start with a direct, simple explanation.\n"
        "2) Give a short practical intuition or real-world example.\n"
        "3) If useful, suggest one follow-up question.\n\n"
        "Knowledge policy:\n"
        "- Treat selected material context as primary evidence.\n"
        "- If context is partial, you may add minimal real-world clarification clearly marked as such.\n"
        "- Do not invent claims about the selected material.\n"
        "- If alternatives are asked, mention material-backed options first, then broader options as general knowledge.\n\n"
        f"Selected material IDs: {', '.join(str(note_id) for note_id in selected_note_ids)}\n\n"
        "Context:\n"
        f"{context_text}\n\n"
        "Keep answer concise but helpful."
    )

    answer = _call_groq_chat([
        {"role": "system", "content": prompt},
        {"role": "user", "content": question},
    ])
    if not answer:
        preview_points = [chunk.strip()[:180] for chunk in documents[:3] if chunk.strip()]
        if preview_points:
            bullets = "\n".join(f"- {point}" for point in preview_points)
            answer = (
                "Based on the selected materials, here are relevant points:\n"
                f"{bullets}\n"
                "\nIf this does not match your intent, clear material selection to use general chat."
            )
        else:
            answer = "I could not find relevant content in the selected materials."

    sources = []
    for item in metadatas:
        source = item.get("source", "note") if isinstance(item, dict) else "note"
        if source not in sources:
            sources.append(source)

    return {"answer": answer, "sources": sources}
