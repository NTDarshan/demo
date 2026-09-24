import type { Metadata } from "next";
import { EmptyState, PageHeader, Panel } from "@/components/ui/panel";
import { guardPage } from "@/lib/auth/page-guard";

export const metadata: Metadata = { title: "Reconciliation" };

// Built in Phase 5.
export default async function ReconciliationPage() {
  await guardPage("reconciliation.run");
  return (
    <>
      <PageHeader title="Reconciliation" description="Match a gateway settlement file against recorded payments." />
      <Panel>
        <EmptyState title="Reconciliation screen arrives in Phase 5">The matching API is ready: POST a CSV to /api/reconciliation.</EmptyState>
      </Panel>
    </>
  );
}
