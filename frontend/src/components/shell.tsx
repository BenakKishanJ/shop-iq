"use client";

import { useEffect, useState } from "react";
import { Bot, Moon, ShieldCheck, Sun } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import ChatView, { CHAT_MODELS, EMBED_MODELS } from "@/components/chat";
import PolicyLibrary from "@/components/policy-library";
import Governance from "@/components/governance";
import SystemStatus from "@/components/system-status";

type View = "chat" | "policies" | "governance";
type Theme = "light" | "dark";

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

export default function Shell() {
  const [view, setView] = useState<View>("chat");
  const [model, setModel] = useState(CHAT_MODELS[0].value);
  const [embedModel, setEmbedModel] = useState(EMBED_MODELS[0].value);
  const [theme, setTheme] = useState<Theme>(() =>
    typeof window === "undefined"
      ? "dark"
      : localStorage.getItem("theme") === "light"
        ? "light"
        : "dark"
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  function toggleTheme() {
    setTheme((t) => {
      const next: Theme = t === "dark" ? "light" : "dark";
      localStorage.setItem("theme", next);
      return next;
    });
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

          <Tabs value={view} onValueChange={(v) => setView(v as View)}>
            <TabsList className="h-9 gap-1 rounded-xl border-border bg-muted/50">
              <TabsTrigger value="chat" className="rounded-lg text-fluid-xs">
                Chat
              </TabsTrigger>
              <TabsTrigger value="policies" className="rounded-lg text-fluid-xs">
                Policies
              </TabsTrigger>
              <TabsTrigger value="governance" className="rounded-lg text-fluid-xs">
                <span className="flex items-center gap-1.5">
                  <ShieldCheck className="size-3.5" />
                  Governance
                </span>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex shrink-0 items-center gap-2">
            <Badge
              variant="outline"
              className="hidden border-border text-fluid-xs text-muted-foreground lg:inline-flex"
            >
              <span className="relative mr-1 flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand" />
              </span>
              10 tools · audited
            </Badge>
            <SystemStatus />
            {view === "chat" && (
              <div className="flex items-center gap-1.5">
                <Select value={embedModel} onValueChange={(v) => v && setEmbedModel(v)}>
                  <SelectTrigger
                    className="h-8 w-auto text-fluid-xs text-foreground md:w-44"
                    title="Embedding model"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EMBED_MODELS.map((m) => (
                      <SelectItem key={m.value} value={m.value} className="text-fluid-xs">
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={model} onValueChange={(v) => v && setModel(v)}>
                  <SelectTrigger className="h-8 w-auto text-fluid-xs text-foreground md:w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CHAT_MODELS.map((m) => (
                      <SelectItem key={m.value} value={m.value} className="text-fluid-xs">
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>
        </div>
      </header>

      <main className="relative z-10 flex min-h-0 flex-1 flex-col">
        {view === "chat" && <ChatView model={model} embedModel={embedModel} />}
        {view === "policies" && <PolicyLibrary />}
        {view === "governance" && <Governance />}
      </main>

      <footer className="relative z-10 shrink-0 border-t border-border bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-3 px-4 py-2 sm:px-6 lg:px-10">
          <p className="flex items-center gap-1.5 text-fluid-xs text-muted-foreground">
            <Bot className="size-3.5" />
            ShopIQ · RAG + MCP + agent governance demo
          </p>
          <p className="hidden text-fluid-xs text-muted-foreground sm:block">
            Every agent action is logged · policies are cited · big reorders need
            sign-off
          </p>
        </div>
      </footer>
    </div>
  );
}
