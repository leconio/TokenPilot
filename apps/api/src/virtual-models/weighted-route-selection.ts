interface WeightedTarget {
  readonly modelId: string;
  readonly weight: { toNumber(): number };
}

function deterministicFraction(value: string): number {
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 4_294_967_296;
}

export function orderSimulationTargets<T extends WeightedTarget>(
  targets: readonly T[],
  routeTag: string,
  selectionKey: string | undefined,
): { readonly mode: "ordered" | "weighted"; readonly targets: readonly T[] } {
  const weighted = targets.some((target) => target.weight.toNumber() !== 1);
  if (!weighted || selectionKey === undefined) return { mode: "ordered", targets };

  const total = targets.reduce((sum, target) => sum + target.weight.toNumber(), 0);
  const point = deterministicFraction(`${routeTag}:${selectionKey}`) * total;
  let cumulative = 0;
  let selected = targets[0]!;
  for (const target of targets) {
    cumulative += target.weight.toNumber();
    if (point < cumulative) {
      selected = target;
      break;
    }
  }
  return {
    mode: "weighted",
    targets: [selected, ...targets.filter((target) => target.modelId !== selected.modelId)],
  };
}
