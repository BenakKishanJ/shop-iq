"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, ChevronDown, FilePlus2, Loader2, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { addPolicy, getPolicies, type PolicyDoc } from "@/lib/api";

function Section({ section, content }: { section: string; content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border bg-background/50">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="font-mono text-fluid-xs text-foreground">{section}</span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && (
        <p className="border-t border-border px-3 py-2.5 text-fluid-sm leading-relaxed text-muted-foreground">
          {content}
        </p>
      )}
    </div>
  );
}

function PolicyCard({ doc }: { doc: PolicyDoc }) {
  return (
    <Card className="rounded-2xl border-border bg-card/70 p-4 shadow-sm backdrop-blur-xl">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
            <BookOpen className="size-4" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-fluid-base font-semibold text-foreground">
              {doc.title}
            </h3>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-fluid-xs text-muted-foreground">
              <Badge variant="outline" className="border-border font-mono">
                {doc.chunks} chunks
              </Badge>
              <span>{doc.source_type}</span>
              <span>·</span>
              <span>{new Date(doc.created_at).toLocaleDateString()}</span>
            </p>
          </div>
        </div>
      </div>
      <Separator className="my-3" />
      <div className="flex flex-col gap-2">
        {doc.sections.map((s) => (
          <Section key={s.section} section={s.section} content={s.content} />
        ))}
      </div>
    </Card>
  );
}

export default function PolicyLibrary() {
  const [docs, setDocs] = useState<PolicyDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getPolicies();
      setDocs(res.documents);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleAdd() {
    if (!title.trim() || !content.trim() || saving) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await addPolicy(title.trim(), content);
      setSaveMsg(`Added "${title.trim()}" — ${res.chunks} chunks embedded. Ask the co-pilot about it!`);
      setTitle("");
      setContent("");
      setShowForm(false);
      await refresh();
    } catch (err) {
      setSaveMsg(`Failed to add: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-1 flex-col px-4 py-6 sm:px-6 lg:max-w-5xl lg:py-8">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-fluid-lg font-bold tracking-tight text-foreground">
            Policy Library
          </h2>
          <p className="text-fluid-xs text-muted-foreground">
            Ground-truth documents the co-pilot searches and cites. Add a new
            policy and it is immediately searchable.
          </p>
        </div>
        <Button
          onClick={() => setShowForm((s) => !s)}
          className="bg-brand text-white shadow-lg shadow-brand/25 transition-all hover:bg-brand-strong"
        >
          {showForm ? <Plus className="size-4 rotate-45" /> : <Plus className="size-4" />}
          {showForm ? "Close" : "Add policy"}
        </Button>
      </div>

      {showForm && (
        <Card className="animate-fade-up mb-5 rounded-2xl border-border bg-card/70 p-4 shadow-sm backdrop-blur-xl md:p-5">
          <div className="flex items-center gap-2 text-fluid-sm font-medium text-foreground">
            <FilePlus2 className="size-4 text-brand" />
            Add a policy document
          </div>
          <div className="mt-3 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="policy-title" className="text-fluid-xs text-muted-foreground">
                Title
              </Label>
              <Input
                id="policy-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Clearance and Markdown Rules"
                className="border-border bg-background/60"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="policy-content" className="text-fluid-xs text-muted-foreground">
                Content — use <span className="font-mono">## Heading</span> for each section
              </Label>
              <Textarea
                id="policy-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={"## Markdown Stages\nClearance items are marked down in three stages over six weeks.\n\n## Staff Rules\nStaff cannot buy clearance stock until week two."}
                className="min-h-36 border-border bg-background/60 font-mono text-fluid-xs"
              />
            </div>
            <div className="flex items-center gap-3">
              <Button
                onClick={handleAdd}
                disabled={saving || !title.trim() || !content.trim()}
                className="bg-brand text-white transition-all hover:bg-brand-strong disabled:bg-muted disabled:text-muted-foreground"
              >
                {saving ? <Loader2 className="size-4 animate-spin" /> : <FilePlus2 className="size-4" />}
                {saving ? "Embedding…" : "Add & embed"}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {saveMsg && (
        <p
          className={`mb-4 rounded-xl border px-3 py-2 text-fluid-xs ${
            saveMsg.startsWith("Failed")
              ? "border-reject/30 bg-reject-bg text-reject"
              : "border-approve/30 bg-approve-bg text-approve"
          }`}
        >
          {saveMsg}
        </p>
      )}

      {error && (
        <p className="mb-4 rounded-xl border border-reject/30 bg-reject-bg px-3 py-2 text-fluid-xs text-reject">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-fluid-xs text-muted-foreground">Loading policies…</p>
      ) : (
        <div className="flex flex-col gap-4 overflow-y-auto pb-6">
          {docs.map((doc) => (
            <PolicyCard key={doc.doc_id} doc={doc} />
          ))}
          {docs.length === 0 && (
            <p className="text-fluid-sm text-muted-foreground">
              No policies yet — add your first document above.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
