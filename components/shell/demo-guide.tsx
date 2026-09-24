"use client";

import { BookMarked } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { can, type Role } from "@/lib/auth/permissions";
import { SCENARIOS } from "@/lib/demo/scenarios";

// Phase 5 adds "Reset demo data" here for admins.
export function DemoGuide({ role, footer }: { role: Role; footer?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const canBrowse = can(role, "students.view_all");
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" aria-label="Open demo guide">
          <BookMarked aria-hidden />
          <span className="hidden md:inline">Demo guide</span>
        </Button>
      </SheetTrigger>
      <SheetContent title="Demo guide" description="Seven students set up to show each part of the ledger." footer={footer}>
        {!canBrowse ? (
          <p className="mb-4 rounded tint-accent px-3 py-2 text-sm">
            You are viewing as a student. Switch to Admin or Accountant in the top bar to open the other students.
          </p>
        ) : null}
        <ol className="space-y-1">
          {SCENARIOS.map((s, i) => (
            <li key={s.rollNo} className="rounded border border-transparent px-3 py-3 hover:border-line">
              <div className="flex items-baseline gap-2">
                <span className="figure w-4 text-sm text-muted">{i + 1}</span>
                {canBrowse ? (
                  <Link href={`/students/${s.rollNo}`} onClick={() => setOpen(false)} className="font-medium text-accent hover:underline">
                    {s.name}
                  </Link>
                ) : (
                  <span className="font-medium">{s.name}</span>
                )}
                <span className="font-mono text-xs text-muted">{s.rollNo}</span>
              </div>
              <p className="ml-6 mt-1 text-muted">{s.story}</p>
              <p className="ml-6 mt-1">
                <span className="text-muted">Try: </span>
                {s.tryThis}
              </p>
            </li>
          ))}
        </ol>
      </SheetContent>
    </Sheet>
  );
}
