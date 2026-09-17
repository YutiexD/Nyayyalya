import os
from typing import List
import chromadb
from google import genai
from google.genai import types

# 1. Initialize the Gemini Client
api_key = os.environ.get("GEMINI_API_KEY")
if not api_key:
    raise ValueError("Please set the GEMINI_API_KEY environment variable.")

client = genai.Client(api_key=api_key)

# 2. Text Embeddings Generator
def get_embeddings(texts: List[str]) -> List[List[float]]:
    """Generates embeddings using Google's text-embedding-004 model."""
    response = client.models.embed_content(
        model="text-embedding-004",
        contents=texts,
        config=types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT")
    )
    return [e.values for e in response.embeddings]

def get_query_embedding(query: str) -> List[float]:
    """Generates query embedding with RETRIEVAL_QUERY optimization."""
    response = client.models.embed_content(
        model="text-embedding-004",
        contents=[query],
        config=types.EmbedContentConfig(task_type="RETRIEVAL_QUERY")
    )
    return response.embeddings[0].values

# 3. Vector Database Management (ChromaDB)
class GeminiRAGStore:
    def __init__(self, collection_name: str = "gemini_knowledge_base"):
        self.chroma_client = chromadb.Client()  # In-memory DB (or use PersistentClient)
        self.collection = self.chroma_client.get_or_create_collection(name=collection_name)

    def add_documents(self, documents: List[str]):
        """Embeds and indexes document chunks into the collection."""
        embeddings = get_embeddings(documents)
        ids = [f"doc_{i}" for i in range(len(documents))]
        self.collection.add(
            documents=documents,
            embeddings=embeddings,
            ids=ids
        )
        print(f"Indexed {len(documents)} documents successfully.")

    def retrieve(self, query: str, top_k: int = 3) -> List[str]:
        """Retrieves top-k relevant document chunks for a query."""
        query_vector = get_query_embedding(query)
        results = self.collection.query(
            query_embeddings=[query_vector],
            n_results=top_k
        )
        return results["documents"][0]

# 4. RAG Query Execution & Generation
def ask_gemini_rag(query: str, vector_store: GeminiRAGStore, model: str = "gemini-2.5-flash") -> str:
    """Retrieves relevant context and queries Gemini with grounding instructions."""
    retrieved_chunks = vector_store.retrieve(query, top_k=3)
    context = "\n---\n".join(retrieved_chunks)

    system_instruction = (
        "You are an assistant answering questions strictly based on the provided context. "
        "If the answer cannot be determined from the context, state that the information "
        "is not available."
    )

    prompt = f"""Context:
{context}

Question:
{query}

Answer based strictly on the context provided:"""

    response = client.models.generate_content(
        model=model,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=0.2
        )
    )
    return response.text

# -------------------------------------------------------------
# Demonstration
# -------------------------------------------------------------
if __name__ == "__main__":
    # Sample corpus
    sample_docs = [
        "Project Orion was initiated in Q1 2026 to migrate data pipelines to real-time event streaming.",
        "The team lead for Project Orion is Sarah Jenkins, based in the Seattle office.",
        "Deployment phase for Orion is scheduled for November 15, 2026, targeting 99.99% SLA.",
        "Project Gemini deals exclusively with multimodal customer support workflows.",
        "All engineers on the Orion infrastructure track must undergo Rust and Kafka certification."
    ]

    # Initialize store and index documents
    rag_store = GeminiRAGStore()
    rag_store.add_documents(sample_docs)

    # Ask questions
    query = "When is Project Orion launching and who is leading it?"
    print(f"\nQuery: {query}\n")
    answer = ask_gemini_rag(query, rag_store)
    print("Gemini Response:\n", answer)