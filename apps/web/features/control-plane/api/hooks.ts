"use client";

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";

import { controlGet, controlMutate, type ListQuery } from "./client";

export function useControlQuery<T>(
  key: readonly unknown[],
  path: string | null,
  parameters?: ListQuery,
  options?: Omit<UseQueryOptions<T>, "queryKey" | "queryFn">,
) {
  return useQuery<T>({
    queryKey: [...key, parameters],
    queryFn: () => controlGet<T>(path as string, parameters),
    enabled: path !== null,
    ...options,
  });
}

export function useControlMutation<TResponse, TBody>(
  path: string | ((body: TBody) => string),
  method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
  invalidate: readonly unknown[] = [],
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) =>
      controlMutate<TResponse, TBody>(typeof path === "function" ? path(body) : path, body, method),
    onSuccess: async () => {
      await Promise.all(invalidate.map((key) => client.invalidateQueries({ queryKey: [key] })));
    },
  });
}
