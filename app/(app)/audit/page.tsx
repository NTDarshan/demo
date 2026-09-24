import type { Metadata } from "next";
import { EmptyState, PageHeader, Panel } from "@/components/ui/panel";
import { guardPage } from "@/lib/auth/page-guard";

export const metadata: Metadata = { title: "Audit log" };

// Built in Phase 5.
export default async function AuditPage() {
  await guardPage("audit.view");
  return (
    <>
      <PageHeader title="Audit log" description="Who changed what, in plain sentences." />
      <Panel>
        <EmptyState title="Audit log arrives in Phase 5">Every money function already writes to it.</EmptyState>
      </Panel>
    </>
  );
}
