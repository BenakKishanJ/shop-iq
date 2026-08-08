// Same-origin by default: the static build is served by the backend itself,
// so /api/* is relative. Dev keeps the old default via frontend/.env.local
// (NEXT_PUBLIC_API_URL is inlined at build time).
const API = process.env.NEXT_PUBLIC_API_URL ?? "";

export type PolicySection = { section: string; content: string };

export type PolicyDoc = {
  doc_id: number;
  title: string;
  source_type: string;
  created_at: string;
  chunks: number;
  sections: PolicySection[];
};

export type GovernanceAction = {
  action_id: number;
  tool_name: string;
  arguments: Record<string, unknown> | null;
  result: { text?: string } | null;
  status: "executed" | "pending_approval" | "approved" | "rejected" | string;
  reasoning: string | null;
  created_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  flag_id: number | null;
  suggested_quantity: number | null;
};

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body.detail) detail = body.detail;
    } catch {
      /* keep status */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export function getPolicies(): Promise<{ documents: PolicyDoc[] }> {
  return json("/api/policies");
}

export function addPolicy(
  title: string,
  content: string
): Promise<{ doc_id: number; chunks: number }> {
  return json("/api/policies", {
    method: "POST",
    body: JSON.stringify({ title, content }),
  });
}

export function getActions(limit = 40): Promise<{ actions: GovernanceAction[] }> {
  return json(`/api/actions?limit=${limit}`);
}

export function resolveAction(
  actionId: number,
  approved: boolean
): Promise<{ message: string }> {
  return json(`/api/actions/${actionId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ approved }),
  });
}

export type LlmHealth = {
  status: string;
  configured_model: string;
  model: string | null;
  response: string;
};

export type EmbeddingsHealth = {
  status: string;
  model: string;
  vectors: number;
  dims: number;
};

export function getLlmHealth(): Promise<LlmHealth> {
  return json("/api/health/llm");
}

export function getEmbeddingsHealth(): Promise<EmbeddingsHealth> {
  return json("/api/health/embeddings");
}
