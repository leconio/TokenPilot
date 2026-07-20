import { Suspense } from "react";

import { ConsoleShell } from "../../../components/console-shell";

export default function ApplicationLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <Suspense fallback={<div className="loading">正在打开应用…</div>}>
      <ConsoleShell>{children}</ConsoleShell>
    </Suspense>
  );
}
