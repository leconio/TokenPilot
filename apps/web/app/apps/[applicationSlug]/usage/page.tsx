import { Suspense } from "react";

import { UsagePage } from "@/features/control-plane/usage/usage-page";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <UsagePage />
    </Suspense>
  );
}
