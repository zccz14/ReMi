import { Outlet } from "react-router-dom";
import { NavBar } from "./NavBar";
import { EphemeralWarning } from "../common/EphemeralWarning";
import { useAuth } from "../../hooks/use-auth";

export function AppShell() {
  const { isEphemeral } = useAuth();

  return (
    <div className="flex flex-col h-screen max-w-lg mx-auto">
      {isEphemeral && <EphemeralWarning />}
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
      <NavBar />
    </div>
  );
}
