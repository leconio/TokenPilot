"use client";

import { useState } from "react";

export function useCursorPages(scope: string) {
  const [state, setState] = useState<{
    readonly scope: string;
    readonly cursors: readonly (string | null)[];
  }>({ scope: "", cursors: [null] });
  const cursors = state.scope === scope ? state.cursors : [null];
  const page = cursors.length;
  return {
    cursor: cursors.at(-1) ?? null,
    page,
    previous: () => setState({ scope, cursors: cursors.slice(0, Math.max(cursors.length - 1, 1)) }),
    next: (cursor: string) => setState({ scope, cursors: [...cursors, cursor] }),
  } as const;
}
