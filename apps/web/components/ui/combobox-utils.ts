export interface ComboboxOption {
  readonly value: string;
  readonly label: string;
  readonly keywords?: string;
  readonly disabled?: boolean;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function comboboxCommandFilter(
  value: string,
  search: string,
  keywords: readonly string[] = [],
): number {
  const query = normalized(search);
  if (query.length === 0) return 1;
  return [value, ...keywords].some((candidate) => normalized(candidate).includes(query)) ? 1 : 0;
}

export function comboboxCustomValue(
  search: string,
  options: readonly ComboboxOption[],
  allowCustomValue: boolean,
): string | undefined {
  const candidate = search.trim();
  if (!allowCustomValue || candidate.length === 0) return undefined;
  const exact = normalized(candidate);
  return options.some(
    (option) => normalized(option.value) === exact || normalized(option.label) === exact,
  )
    ? undefined
    : candidate;
}
