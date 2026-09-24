"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";

// Filters live in the URL (?q=&course=&status=) so a filtered list can be linked and
// survives a refresh. Typing is debounced; selects apply immediately.
export function StudentFilters({ courses }: { courses: { code: string; name: string }[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(params.get("q") ?? "");
  const timer = useRef<number | undefined>(undefined);

  function apply(next: Record<string, string | null>) {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    const qs = sp.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  }

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function onSearch(value: string) {
    setQ(value);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => apply({ q: value.trim() || null }), 250);
  }

  const hasFilters = Boolean(params.get("q") || params.get("course") || params.get("status"));

  return (
    <div className="flex flex-wrap items-center gap-2" aria-busy={pending}>
      <div className="relative w-full sm:w-72">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input value={q} onChange={(e) => onSearch(e.target.value)} placeholder="Name or roll number" className="pl-9" aria-label="Search students" type="search" />
      </div>
      <Select aria-label="Course" value={params.get("course") ?? ""} onChange={(e) => apply({ course: e.target.value || null })} className="w-auto min-w-[150px] flex-1 sm:flex-none">
        <option value="">All courses</option>
        {courses.map((c) => (
          <option key={c.code} value={c.code}>
            {c.code === "CSE" ? "B.Tech CSE" : c.code === "BCOM" ? "B.Com" : c.code}
          </option>
        ))}
      </Select>
      <Select aria-label="Status" value={params.get("status") ?? ""} onChange={(e) => apply({ status: e.target.value || null })} className="w-auto min-w-[150px] flex-1 sm:flex-none">
        <option value="">Any status</option>
        <option value="OVERDUE">Overdue</option>
        <option value="DUE">Due</option>
        <option value="PAID">Paid</option>
        <option value="ADVANCE">Advance</option>
      </Select>
      {hasFilters ? (
        <Button
          variant="ghost"
          size="md"
          onClick={() => {
            setQ("");
            startTransition(() => router.replace(pathname, { scroll: false }));
          }}
        >
          <X aria-hidden />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
