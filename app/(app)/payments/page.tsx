import type { Metadata } from "next";
import { EmptyState, PageHeader, Panel } from "@/components/ui/panel";
import { guardPage } from "@/lib/auth/page-guard";

export const metadata: Metadata = { title: "Payments" };

// Built in Phase 4.
export default async function PaymentsPage() {
  await guardPage("students.view_all");
  return (
    <>
      <PageHeader title="Payments" description="Every payment across students, with its gateway state." />
      <Panel>
        <EmptyState title="Payments list arrives in Phase 4">Open a student to see their payments for now.</EmptyState>
      </Panel>
    </>
  );
}
