import os

import numpy as np
from sentence_transformers import SentenceTransformer
from dotenv import load_dotenv

load_dotenv()

_model = None


def get_embedder():
    global _model
    if _model is None:
        _model = SentenceTransformer(os.environ.get("EMBEDDING_MODEL", "all-MiniLM-L6-v2"))
    return _model


def embed_text(text: str) -> list[float]:
    model = get_embedder()
    vec = model.encode(text, normalize_embeddings=True)
    return vec.tolist()


def embed_texts(texts: list[str]) -> list[list[float]]:
    model = get_embedder()
    vecs = model.encode(texts, normalize_embeddings=True)
    return [v.tolist() for v in vecs]
