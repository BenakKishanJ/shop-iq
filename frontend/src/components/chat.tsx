"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Bot, Loader2, Moon, Sparkles, Sun } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { parseCitations } from "@/lib/parse-citations";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const MODELS = [
  { value: "openai/gpt-oss-20b:free", label: "GPT-OSS 20B · free" },
  { value: "openai/gpt-5-mini", label: "GPT-5 Mini" },
  { value: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
];

const SUGGESTIONS = [
  "Are we low on the top-selling product?",
  "Can customers return opened electronics?",
  "We're out of the white hanging heart t-light holder, order more and tell the team.",
  "How did sales look for the top seller last week?",
];

type ToolUse = { name: string; arguments: Record<string, unknown> };

type Message = {
  role: "user" | "assistant";
  content: string;
  toolUses: ToolUse[];
};

type Theme = "light" | "dark";

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

function ThemeToggle({
  theme,
  onToggle,
}: {
  theme: Theme;
  onToggle: () => void;
}) {
  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onToggle}
      aria-label={label}
      title={label}
      className="size-8 rounded-lg border-border text-muted-foreground hover:text-foreground"
    >
      {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState(MODELS[0].value);
  const [theme, setTheme] = useState<Theme>(() =>
    typeof window === "undefined"
      ? "dark"
      : localStorage.getItem("theme") === "light"
        ? "light"
        : "dark"
  );
  const bottomRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function toggleTheme() {
    setTheme((t) => {
      const next: Theme = t === "dark" ? "light" : "dark";
      localStorage.setItem("theme", next);
      return next;
    });
  }

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
    <div className="relative flex h-dvh flex-col overflow-hidden">
      <header className="relative z-10 shrink-0 border-b border-border bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center justify-between gap-3 px-4 sm:px-6 md:h-16 lg:px-10">
          <div className="flex min-w-0 items-center gap-3">
            <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand text-sm font-bold text-white shadow-sm md:h-10 md:w-10">
              S
              <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-brand ring-2 ring-background" />
            </div>
            <div className="min-w-0 leading-tight">
              <h1 className="text-fluid-base truncate font-bold tracking-tight text-foreground">
                ShopIQ
              </h1>
              <p className="truncate text-fluid-xs text-muted-foreground">
                Store operations co-pilot
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Badge
              variant="outline"
              className="hidden border-border text-fluid-xs text-muted-foreground sm:inline-flex"
            >
              <span className="relative mr-1 flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand" />
              </span>
              7 tools · grounded
            </Badge>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <Select value={model} onValueChange={(v) => v && setModel(v)}>
              <SelectTrigger className="h-8 w-auto text-fluid-xs text-foreground md:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODELS.map((m) => (
                  <SelectItem key={m.value} value={m.value} className="text-fluid-xs">
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </header>

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
              Enter to send · Shift+Enter for a new line · answers cite their sources
            </p>
          </Card>
        </div>
      </footer>
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
        database and your policy documents through MCP tools, and cites every
        policy claim.
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
