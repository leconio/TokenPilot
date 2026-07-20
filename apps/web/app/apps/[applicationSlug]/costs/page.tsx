import { Suspense } from "react";

import { CostsPage } from "@/features/control-plane/costs/costs-page";

export default function Page() {
  return (
    <Suspense fallback={<div className="loading">正在汇总模型花费…</div>}>
      <CostsPage />
    </Suspense>
  );
}
