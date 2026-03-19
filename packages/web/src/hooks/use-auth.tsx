import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { KeyStore } from "@remi/client";
import { ApiClient } from "../lib/api-client";

interface AuthState {
  initialized: boolean;
  publicKey: string;
  isEphemeral: boolean;
  apiClient: ApiClient;
  keyStore: KeyStore;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const keyStore = new KeyStore();
    keyStore
      .init()
      .then(() => {
        const apiClient = new ApiClient({
          baseUrl: import.meta.env.VITE_API_BASE ?? "http://localhost:3000",
          keyStore,
        });
        setState({
          initialized: true,
          publicKey: keyStore.getPublicKey(),
          isEphemeral: keyStore.isEphemeral(),
          apiClient,
          keyStore,
        });
      })
      .catch((err) => {
        setError(err.message ?? "Failed to initialize identity");
      });
  }, []);

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen text-red-500">{error}</div>
    );
  }

  if (!state) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
  }

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
