"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  getEmbeddingsHealth,
  getLlmHealth,
  type EmbeddingsHealth,
  type LlmHealth,
} from "@/lib/api";

type LlmState = { ok: boolean; data?: LlmHealth; error?: string };
type EmbedState = { ok: boolean; data?: EmbeddingsHealth; error?: string };

function Dot({ ok }: { ok: boolean | null }) {
  const color =
    ok === true ? "bg-approve" : ok === false ? "bg-reject" : "bg-muted-foreground/40";
  return (
    <span className="relative mr-1 flex h-1.5 w-1.5">
      {ok === true && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-approve opacity-75" />
      )}
      <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${color}`} />
    </span>
  );
}

export default function SystemStatus() {
  const [llm, setLlm] = useState<LlmState | null>(null);
  const [emb, setEmb] = useState<EmbedState | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLlm({ ok: true, data: await getLlmHealth() });
    } catch (err) {
      setLlm({ ok: false, error: (err as Error).message });
    }
    try {
      setEmb({ ok: true, data: await getEmbeddingsHealth() });
    } catch (err) {
      setEmb({ ok: false, error: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const llmTooltip = llm
    ? llm.ok
      ? `routed: ${llm.data?.model ?? "n/a"} · "${llm.data?.response}"`
      : `error: ${llm.error}`
    : "checking…";
  const embTooltip = emb
    ? emb.ok
      ? `${emb.data?.model} · ${emb.data?.vectors} vector · ${emb.data?.dims}d`
      : `error: ${emb.error}`
    : "checking…";

  return (
    <div className="hidden items-center gap-1.5 lg:flex">
      <Badge
        variant="outline"
        title={llmTooltip}
        className="border-border text-fluid-xs text-muted-foreground"
      >
        <Dot ok={llm ? llm.ok : null} /> LLM{" "}
        {llm ? (llm.ok ? llm.data?.configured_model : "down") : "…"}
      </Badge>
      <Badge
        variant="outline"
        title={embTooltip}
        className="border-border text-fluid-xs text-muted-foreground"
      >
        <Dot ok={emb ? emb.ok : null} /> Embed{" "}
        {emb ? (emb.ok ? `${emb.data?.dims}d` : "down") : "…"}
      </Badge>
      <Button
        onClick={() => void refresh()}
        size="icon"
        variant="ghost"
        aria-label="Refresh model status"
        title="Refresh model status"
        className="size-8 rounded-lg border-border text-muted-foreground hover:text-foreground"
      >
        <RefreshCw className="size-3.5" />
      </Button>
    </div>
  );
}
