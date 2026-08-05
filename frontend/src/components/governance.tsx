"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, RefreshCw, ShieldCheck, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { getActions, resolveAction, type GovernanceAction } from "@/lib/api";

const STATUS_STYLES: Record<string, string> = {
  executed: "border-border bg-muted/50 text-muted-foreground",
  pending_approval: "border-pending/40 bg-pending-bg text-pending",
  approved: "border-approve/40 bg-approve-bg text-approve",
  rejected: "border-reject/40 bg-reject-bg text-reject",
};

function StatusBadge({ status }: { status: string }) {
  const label = status.replace("_", " ");
  return (
    <Badge
      variant="outline"
      className={`font-mono text-fluid-xs ${STATUS_STYLES[status] ?? "border-border text-muted-foreground"}`}
    >
      {label}
    </Badge>
  );
}

function ActionCard({
  action,
  onResolve,
}: {
  action: GovernanceAction;
  onResolve: (id: number, approved: boolean) => void;
}) {
  const args = action.arguments ? JSON.stringify(action.arguments) : "{}";
  const when = action.created_at
    ? new Date(action.created_at).toLocaleTimeString()
    : "";
  const isPending = action.status === "pending_approval";

  return (
    <Card className="shrink-0 rounded-2xl border-border bg-card/70 p-4 shadow-sm backdrop-blur-xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-fluid-xs text-muted-foreground">
            #{action.action_id}
          </span>
          <Badge
            variant="outline"
            className="border-border bg-brand/10 font-mono text-fluid-xs text-brand"
          >
            {action.tool_name}
          </Badge>
          <StatusBadge status={action.status} />
        </div>
        <span className="text-fluid-xs text-muted-foreground">
          {when}
          {action.resolved_by && ` · ${action.resolved_by}`}
        </span>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <div>
          <p className="text-fluid-xs font-medium text-muted-foreground">Arguments</p>
          <p className="mt-0.5 truncate font-mono text-fluid-xs text-foreground" title={args}>
            {args}
          </p>
        </div>
        {action.reasoning && (
          <div>
            <p className="text-fluid-xs font-medium text-muted-foreground">Reasoning</p>
            <p className="mt-0.5 text-fluid-xs leading-relaxed text-foreground">
              {action.reasoning}
            </p>
          </div>
        )}
      </div>

      {action.suggested_quantity != null && (
        <div className="mt-3 flex items-center gap-2">
          <Badge variant="outline" className="border-border font-mono text-fluid-xs text-foreground">
            suggest {action.suggested_quantity} units
          </Badge>
        </div>
      )}

      {isPending && (
        <>
          <Separator className="my-3" />
          <div className="flex items-center gap-2">
            <Button
              onClick={() => onResolve(action.action_id, true)}
              size="sm"
              className="bg-approve text-white transition-all hover:brightness-110"
            >
              <Check className="size-4" /> Approve
            </Button>
            <Button
              onClick={() => onResolve(action.action_id, false)}
              size="sm"
              variant="outline"
              className="border-reject/40 text-reject hover:bg-reject-bg hover:text-reject"
            >
              <X className="size-4" /> Reject
            </Button>
            <span className="text-fluid-xs text-muted-foreground">
              waits on human sign-off
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

export default function Governance() {
  const [actions, setActions] = useState<GovernanceAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getActions(50);
      setActions(res.actions);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onResolve(id: number, approved: boolean) {
    setError(null);
    try {
      await resolveAction(id, approved);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const pending = actions.filter((a) => a.status === "pending_approval").length;

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-1 flex-col px-4 py-6 sm:px-6 lg:max-w-5xl lg:py-8">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-fluid-lg font-bold tracking-tight text-foreground">
            <ShieldCheck className="size-5 text-brand" />
            Governance Trail
          </h2>
          <p className="text-fluid-xs text-muted-foreground">
            Every action the agent takes is audited. Reorders over the threshold
            wait here for human sign-off.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pending > 0 && (
            <Badge className="border-pending/40 bg-pending-bg font-mono text-fluid-xs text-pending">
              {pending} pending
            </Badge>
          )}
          <Button
            onClick={() => void refresh()}
            size="icon"
            variant="ghost"
            aria-label="Refresh"
            className="size-8 rounded-lg border-border text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {error && (
        <p className="mb-4 rounded-xl border border-reject/30 bg-reject-bg px-3 py-2 text-fluid-xs text-reject">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-fluid-xs text-muted-foreground">Loading the audit trail…</p>
      ) : (
        <div className="flex flex-col gap-3 overflow-y-auto pb-6">
          {actions.map((a) => (
            <ActionCard key={a.action_id} action={a} onResolve={onResolve} />
          ))}
          {actions.length === 0 && (
            <p className="text-fluid-sm text-muted-foreground">
              No actions logged yet — ask the co-pilot something and watch it appear here.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
