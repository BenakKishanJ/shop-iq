"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, Loader2, Sparkles } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { parseCitations } from "@/lib/parse-citations";

const API = process.env.NEXT_PUBLIC_API_URL ?? "";

export const CHAT_MODELS = [
  { value: "openrouter/free", label: "Free model (auto-routed)" },
  { value: "openai/gpt-oss-20b:free", label: "GPT-OSS 20B · free" },
  {
    value: "nvidia/nemotron-3-ultra-550b-a55b:free",
    label: "Nemotron Ultra 550B · free",
  },
  { value: "openai/gpt-5-mini", label: "GPT-5 Mini" },
  { value: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
];

export const EMBED_MODELS = [
  {
    value: "nvidia/nemotron-3-embed-1b:free",
    label: "Nemotron Embed 1B · 2048d (indexed)",
  },
  { value: "openai/text-embedding-3-small", label: "text-embedding-3-small · 1536d" },
  { value: "BAAI/bge-m3", label: "BGE-M3 · 1024d" },
];

const SUGGESTIONS = [
  "Are we low on the top-selling product?",
  "Can customers return opened electronics?",
  "We're out of the white hanging heart t-light holder, order more and tell the team.",
  "How did sales look for the top seller last week?",
  "What has the agent done today?",
];

type ToolUse = { name: string; arguments: Record<string, unknown> };

type Step =
  | { kind: "think"; text: string }
  | { kind: "tool_call"; name: string; arguments: Record<string, unknown> }
  | { kind: "tool_result"; name: string; result: string };

type Message = {
  role: "user" | "assistant";
  content: string;
  toolUses: ToolUse[];
  steps: Step[];
};

type ServerEvent =
  | { type: "think"; text: string }
  | { type: "tool_call"; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string }
  | { type: "done"; answer: string; tool_uses: ToolUse[] }
  | { type: "error"; detail: string };

function ToolRow({ uses }: { uses: ToolUse[] }) {
  if (uses.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {uses.map((u, i) => (
        <Badge
          key={i}
          variant="outline"
          className="border-border bg-muted/50 font-mono text-fluid-xs text-muted-foreground"
        >
          ⚙ {u.name}
        </Badge>
      ))}
    </div>
  );
}

async function readStream(
  res: Response,
  onEvent: (ev: ServerEvent) => void
): Promise<void> {
  if (!res.body) throw new Error("No response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        try {
          onEvent(JSON.parse(raw) as ServerEvent);
        } catch {
          /* skip malformed frame */
        }
      }
    }
  }
}

function StepLine({ step }: { step: Step }) {
  if (step.kind === "think") {
    return (
      <div className="flex gap-2 text-fluid-xs leading-relaxed text-muted-foreground">
        <span className="shrink-0 select-none text-brand/70">⟡</span>
        <span className="whitespace-pre-wrap italic">{step.text}</span>
      </div>
    );
  }
  if (step.kind === "tool_call") {
    return (
      <div className="flex gap-2 font-mono text-fluid-xs text-foreground">
        <span className="shrink-0 select-none text-brand">→</span>
        <span className="break-all">
          {step.name}({JSON.stringify(step.arguments)})
        </span>
      </div>
    );
  }
  return (
    <div className="flex gap-2 font-mono text-fluid-xs text-muted-foreground">
      <span className="shrink-0 select-none text-brand/60">↳</span>
      <span className="break-all">{step.result}</span>
    </div>
  );
}

function StepsBody({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-muted/40 p-2.5">
      {steps.map((s, i) => (
        <StepLine key={i} step={s} />
      ))}
    </div>
  );
}

function RichText({ content }: { content: string }) {
  const segments = parseCitations(content);
  return (
    <div className="whitespace-pre-wrap text-fluid-base leading-relaxed text-foreground">
      {segments.map((s, i) =>
        s.type === "text" ? (
          <span key={i}>{s.value}</span>
        ) : (
          <Badge
            key={i}
            variant="outline"
            title={`${s.citation.doc} :: ${s.citation.section}`}
            className="mx-1 cursor-help border-border bg-muted/50 font-mono text-fluid-xs text-muted-foreground"
          >
            {s.citation.doc} :: {s.citation.section}
          </Badge>
        )
      )}
    </div>
  );
}

function Thinking() {
  return (
    <div className="flex animate-message-in items-start gap-3">
      <AssistantAvatar />
      <Card className="rounded-2xl rounded-tl-md border-border bg-card/70 px-4 py-3 shadow-sm backdrop-blur-xl">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="thinking-dot inline-block h-1.5 w-1.5 rounded-full bg-brand" />
            <span className="thinking-dot inline-block h-1.5 w-1.5 rounded-full bg-brand/60" />
            <span className="thinking-dot inline-block h-1.5 w-1.5 rounded-full bg-brand/30" />
          </span>
          <span className="text-fluid-xs font-medium">Consulting tools…</span>
        </div>
      </Card>
    </div>
  );
}

function AssistantAvatar() {
  return (
    <Avatar className="mt-0.5 h-8 w-8 shrink-0 rounded-lg bg-brand md:h-9 md:w-9">
      <AvatarFallback className="rounded-lg bg-transparent text-white">
        <Bot className="size-4" />
      </AvatarFallback>
    </Avatar>
  );
}

function LiveSteps({ steps }: { steps: Step[] }) {
  return (
    <div className="flex animate-message-in items-start gap-3">
      <AssistantAvatar />
      <Card className="flex-1 rounded-2xl rounded-tl-md border-border bg-card/70 px-4 py-3.5 shadow-sm backdrop-blur-xl md:px-5 md:py-4">
        <StepsBody steps={steps} />
        <div className="mt-2 flex items-center gap-2 text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="thinking-dot inline-block h-1.5 w-1.5 rounded-full bg-brand" />
            <span className="thinking-dot inline-block h-1.5 w-1.5 rounded-full bg-brand/60" />
            <span className="thinking-dot inline-block h-1.5 w-1.5 rounded-full bg-brand/30" />
          </span>
          <span className="text-fluid-xs font-medium">Consulting tools…</span>
        </div>
      </Card>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-2 py-8 text-center">
      <div className="animate-fade-up flex h-16 w-16 items-center justify-center rounded-2xl bg-brand text-white shadow-xl shadow-brand/25 md:h-20 md:w-20">
        <Sparkles className="size-8 md:size-10" />
      </div>
      <h2 className="mt-6 max-w-2xl text-fluid-xl font-bold tracking-tight text-foreground">
        Your store co-pilot
      </h2>
      <p className="mt-3 max-w-xl text-fluid-base leading-relaxed text-muted-foreground">
        Ask ShopIQ about live stock, sales trends, or store policy. It reads the
        database and your policy documents through MCP tools, cites every policy
        claim, and logs every action in the governance trail.
      </p>
      <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-2.5 md:grid-cols-2">
        {SUGGESTIONS.map((q) => (
          <button
            key={q}
            onClick={() => onPick(q)}
            className="group flex items-center justify-between gap-3 rounded-2xl border border-border bg-card/60 px-4 py-3.5 text-left text-fluid-sm text-foreground shadow-sm backdrop-blur transition-all duration-200 hover:-translate-y-0.5 hover:border-brand/60 hover:bg-card hover:shadow-lg hover:shadow-brand/10"
          >
            {q}
            <ArrowUp className="size-4 shrink-0 -rotate-45 text-brand opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:opacity-100" />
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ChatView({
  model,
  embedModel,
}: {
  model: string;
  embedModel: string;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading, steps]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || loading) return;
    setMessages((m) => [
      ...m,
      { role: "user", content: question, toolUses: [], steps: [] },
    ]);
    setInput("");
    setLoading(true);
    setSteps([]);
    const live: Step[] = [];
    try {
      const res = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, model, embed_model: embedModel }),
      });
      if (!res.ok) {
        let detail = `API error ${res.status}`;
        try {
          const body = await res.json();
          if (body.detail) detail = body.detail;
        } catch {
          /* keep status */
        }
        throw new Error(detail);
      }
      await readStream(res, (ev) => {
        if (ev.type === "think") {
          live.push({ kind: "think", text: ev.text });
        } else if (ev.type === "tool_call") {
          live.push({ kind: "tool_call", name: ev.name, arguments: ev.arguments });
        } else if (ev.type === "tool_result") {
          live.push({ kind: "tool_result", name: ev.name, result: ev.result });
        } else if (ev.type === "done") {
          const finished = [...live];
          setMessages((m) => [
            ...m,
            {
              role: "assistant",
              content: ev.answer,
              toolUses: ev.tool_uses ?? [],
              steps: finished,
            },
          ]);
          return;
        } else if (ev.type === "error") {
          setMessages((m) => [
            ...m,
            {
              role: "assistant",
              content: `Something went wrong: ${ev.detail}`,
              toolUses: [],
              steps: [...live],
            },
          ]);
          return;
        }
        setSteps([...live]);
      });
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: `Something went wrong: ${(err as Error).message}`,
          toolUses: [],
          steps: [],
        },
      ]);
    } finally {
      setLoading(false);
      setSteps([]);
    }
  }

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      <main className="relative z-10 mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col px-4 sm:px-6 lg:px-10">
        {messages.length === 0 ? (
          <EmptyState onPick={send} />
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 py-6 md:gap-5 lg:max-w-5xl lg:py-8 2xl:max-w-6xl">
              {messages.map((msg, i) =>
                msg.role === "user" ? (
                  <div key={i} className="flex animate-message-in justify-end">
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-fluid-base leading-relaxed text-primary-foreground shadow-sm md:max-w-[75%] md:px-5 md:py-3">
                      {msg.content}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex animate-message-in items-start gap-3">
                    <AssistantAvatar />
                    <Card className="flex-1 rounded-2xl rounded-tl-md border-border bg-card/70 px-4 py-3.5 shadow-sm backdrop-blur-xl md:px-5 md:py-4">
                      {msg.steps.length > 0 && (
                        <details className="group mb-2">
                          <summary className="cursor-pointer select-none text-fluid-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                            <span className="mr-1.5 inline-block text-fluid-xs transition-transform group-open:rotate-90">
                              ▶
                            </span>
                            agent steps · {msg.steps.length}
                          </summary>
                          <div className="mt-2">
                            <StepsBody steps={msg.steps} />
                          </div>
                        </details>
                      )}
                      <ToolRow uses={msg.toolUses} />
                      <RichText content={msg.content} />
                    </Card>
                  </div>
                )
              )}
              {loading && (steps.length === 0 ? <Thinking /> : <LiveSteps steps={steps} />)}
              <div ref={bottomRef} />
            </div>
          </ScrollArea>
        )}
      </main>

      <footer className="relative z-10 shrink-0 border-t border-border bg-background/70 backdrop-blur-xl">
        <div className="mx-auto w-full max-w-[1600px] px-4 py-3 sm:px-6 md:py-4 lg:px-10">
          <Card className="rounded-2xl border-border bg-card/70 p-0 shadow-lg shadow-foreground/5 backdrop-blur-xl transition-shadow focus-within:ring-1 focus-within:ring-brand/50">
            <div className="flex items-end gap-2 p-2 md:p-3">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                placeholder="Ask about stock, sales, or store policy…"
                className="max-h-36 min-h-12 flex-1 resize-none border-0 text-fluid-base shadow-none focus-visible:ring-0 md:min-h-14"
                rows={2}
              />
              <Button
                onClick={() => void send(input)}
                disabled={loading || !input.trim()}
                size="icon"
                aria-label="Send message"
                className="h-11 w-11 shrink-0 rounded-xl bg-brand text-white shadow-lg shadow-brand/25 transition-all hover:bg-brand-strong hover:shadow-brand/40 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none md:h-14 md:w-14"
              >
                {loading ? (
                  <Loader2 className="size-5 animate-spin" />
                ) : (
                  <ArrowUp className="size-5" />
                )}
              </Button>
            </div>
            <Separator />
            <p className="px-3 pt-1 pb-1.5 text-fluid-xs text-muted-foreground">
              Enter to send · Shift+Enter for a new line · answers cite their
              sources · every action is logged
            </p>
          </Card>
        </div>
      </footer>
    </div>
  );
}
