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

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export const CHAT_MODELS = [
  { value: "openai/gpt-oss-20b:free", label: "GPT-OSS 20B · free" },
  { value: "openai/gpt-5-mini", label: "GPT-5 Mini" },
  { value: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
];

const SUGGESTIONS = [
  "Are we low on the top-selling product?",
  "Can customers return opened electronics?",
  "We're out of the white hanging heart t-light holder, order more and tell the team.",
  "How did sales look for the top seller last week?",
  "What has the agent done today?",
];

type ToolUse = { name: string; arguments: Record<string, unknown> };

type Message = {
  role: "user" | "assistant";
  content: string;
  toolUses: ToolUse[];
};

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

export default function ChatView({ model }: { model: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || loading) return;
    setMessages((m) => [...m, { role: "user", content: question, toolUses: [] }]);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, model }),
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const data = await res.json();
      setMessages((m) => [
        ...m,
        { role: "assistant", content: data.answer, toolUses: data.tool_uses ?? [] },
      ]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: `Something went wrong: ${(err as Error).message}`,
          toolUses: [],
        },
      ]);
    } finally {
      setLoading(false);
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
                      <ToolRow uses={msg.toolUses} />
                      <RichText content={msg.content} />
                    </Card>
                  </div>
                )
              )}
              {loading && <Thinking />}
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
