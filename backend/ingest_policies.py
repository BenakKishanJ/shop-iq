"""Policy document ingestion: seed docs (and later, uploads) -> chunks -> vectors.

One code path for documents: chunk (respect headings) -> embed -> upsert.
Re-uploading a title REPLACES its chunks (per design doc), so queries
never see stale versions.

Usage:
    python ingest_policies.py            # ingest the seed documents
"""
from typing import Iterable
import re
import requests
from db import apply_schema, get_conn
from embeddings import embed_texts
from policy_seed import SEED_DOCS


def parse_sections(content: str) -> list[tuple[str, str]]:
    """Parse '## Heading\\nbody' blocks into (section, body) pairs.

    Text before the first heading becomes an 'Introduction' section; a
    document with no headings becomes a single Introduction section. This is
    what lets the UI add a new policy as free-form text.
    """
    content = content.strip()
    if not content:
        return []
    parts = re.split(r"(?m)^##\s+", content)
    if len(parts) == 1:
        return [("Introduction", content)]
    sections = []
    if parts[0].strip():
        sections.append(("Introduction", parts[0].strip()))
    for part in parts[1:]:
        heading, _, body = part.partition("\n")
        sections.append((heading.strip(), body.strip()))
    return sections


def chunk_document(title: str, sections: list[tuple[str, str]]) -> list[dict]:
    """Turn (section_title, body) pairs into citable chunks."""
    chunks = []
    for idx, (section, body) in enumerate(sections):
        chunks.append({
            "section": section,
            "content": f"{title} — {section}:\n{body}",
            "chunk_index": idx,
        })
    return chunks


def upsert_document(doc: dict, conn) -> dict:
    """Insert/replace one document and embed+store its chunks."""
    chunks = chunk_document(doc["title"], doc["sections"])

    with conn.cursor() as cur:
        # upsert the document, get its id (on conflict = replace)
        cur.execute(
            """INSERT INTO policy_documents (title, source_type, raw_text)
               VALUES (%s, 'seed', %s)
               ON CONFLICT (title) DO UPDATE
                 SET raw_text = EXCLUDED.raw_text
               RETURNING doc_id""",
            (doc["title"], "\n\n".join(f"{s}:\n{b}" for s, b in doc["sections"])),
        )
        doc_id = cur.fetchone()[0]

        # replace existing chunks for this document
        cur.execute("DELETE FROM document_chunks WHERE doc_id = %s", (doc_id,))

        # embed in batches (rate limits!) then insert
        contents = [c["content"] for c in chunks]
        for i in range(0, len(contents), 20):
            batch = contents[i:i + 20]
            vectors = embed_texts(batch)
            for chunk, vector in zip(chunks[i:i + 20], vectors):
                cur.execute(
                    """INSERT INTO document_chunks
                       (doc_id, section_label, chunk_index, content, embedding)
                       VALUES (%s, %s, %s, %s, %s)""",
                    (doc_id, chunk["section"], chunk["chunk_index"],
                     chunk["content"], vector),
                )
    return {"doc_id": doc_id, "chunks": len(chunks)}


def main():
    conn = get_conn()
    apply_schema(conn)
    conn.commit()
    results = []
    try:
        for doc in SEED_DOCS:
            results.append(upsert_document(doc, conn))
        conn.commit()
    finally:
        conn.close()

    for r in results:
        print(f"  doc {r['doc_id']}: {r['chunks']} chunks")
    print(f"ingested {len(results)} documents, {sum(r['chunks'] for r in results)} chunks")


if __name__ == "__main__":
    main()
