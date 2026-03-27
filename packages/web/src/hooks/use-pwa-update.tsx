import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

interface PwaUpdateContextValue {
  hasUpdate: boolean;
  isApplying: boolean;
  applyUpdate: () => Promise<void>;
}

const PwaUpdateContext = createContext<PwaUpdateContextValue | null>(null);

export function usePwaUpdate(): PwaUpdateContextValue {
  const context = useContext(PwaUpdateContext);

  if (!context) {
    throw new Error("usePwaUpdate must be used within PwaUpdateProvider");
  }

  return context;
}

export function PwaUpdateProvider({ children }: { children: ReactNode }) {
  const { needRefresh } = useRegisterSW();

  const value = useMemo<PwaUpdateContextValue>(
    () => ({
      hasUpdate: needRefresh[0],
      isApplying: false,
      applyUpdate: async () => {},
    }),
    [needRefresh],
  );

  return <PwaUpdateContext.Provider value={value}>{children}</PwaUpdateContext.Provider>;
}
