"use client";

import { createContext, useContext } from "react";

const InstanceTimezoneContext = createContext("UTC");

export function InstanceTimezoneProvider({
  children,
  timezone,
}: Readonly<{ children: React.ReactNode; timezone: string }>) {
  return (
    <InstanceTimezoneContext.Provider value={timezone}>{children}</InstanceTimezoneContext.Provider>
  );
}

export function useInstanceTimezone(): string {
  return useContext(InstanceTimezoneContext);
}
