"use client";

import { StatusBadge } from "@/features/shared/components/status-badge";
import type { RequiredDatastoreHealth } from "@/features/shared/required-datastores";

export function PipelineReadiness({ status }: Readonly<{ status: RequiredDatastoreHealth }>) {
  return (
    <div className="note">
      <strong>数据连接</strong>
      <dl className="definition">
        <div>
          <dt>主数据</dt>
          <dd>
            <StatusBadge value={status.postgres} />
          </dd>
        </div>
        <div>
          <dt>分析数据</dt>
          <dd>
            <StatusBadge value={status.clickhouse} />
          </dd>
        </div>
      </dl>
    </div>
  );
}
