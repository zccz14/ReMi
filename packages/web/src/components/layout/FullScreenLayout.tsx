import { useContext, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { EphemeralWarning } from "../common/EphemeralWarning";
import { AuthContext } from "../../hooks/use-auth";

interface FullScreenLayoutProps {
  title: ReactNode;
  children: ReactNode;
  onBack?: () => void;
}

export function FullScreenLayout({
  title,
  children,
  onBack = () => window.history.back(),
}: FullScreenLayoutProps) {
  const authState = useContext(AuthContext);
  const isEphemeral = authState?.isEphemeral ?? false;

  return (
    <div className="flex flex-col h-screen max-w-lg mx-auto">
      {isEphemeral && <EphemeralWarning />}
      <header className="flex items-center border-b bg-card">
        <button type="button" aria-label="Back" onClick={onBack} className="px-3 py-2">
          <ChevronLeft className="size-5" />
        </button>
        <h1 className="flex-1 text-center font-medium">{title}</h1>
        <div className="px-3 py-2">
          <div className="size-5" />
        </div>
      </header>
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
