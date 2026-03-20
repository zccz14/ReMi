import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { Suspense } from "react";
import { AuthProvider } from "./hooks/use-auth";
import { TooltipProvider } from "./components/ui/tooltip";
import { Toaster } from "./components/ui/sonner";
import { AppShell } from "./components/layout/AppShell";
import { MessagesPage } from "./pages/MessagesPage";
import { ContactsPage } from "./pages/ContactsPage";
import { DiscoverPage } from "./pages/DiscoverPage";
import { MePage } from "./pages/MePage";
import { RemiChatPage } from "./pages/RemiChatPage";
import { AvatarChatPage } from "./pages/AvatarChatPage";
import { ProfilePage } from "./pages/ProfilePage";
import { StatsPage } from "./pages/StatsPage";
import { AnchorsPage } from "./pages/AnchorsPage";
import { SharePage } from "./pages/SharePage";
import { SettingsPage } from "./pages/SettingsPage";
import "./lib/i18n";

function OldShareRedirect() {
  const { pubKey } = useParams<{ pubKey: string }>();
  return <Navigate to={`/profile/${pubKey}`} replace />;
}

export default function App() {
  return (
    <Suspense
      fallback={<div className="flex items-center justify-center min-h-screen">Loading...</div>}
    >
      <BrowserRouter>
        <AuthProvider>
          <TooltipProvider>
            <Routes>
              {/* Tab pages — inside AppShell with NavBar */}
              <Route element={<AppShell />}>
                <Route path="/messages" element={<MessagesPage />} />
                <Route path="/contacts" element={<ContactsPage />} />
                <Route path="/discover" element={<DiscoverPage />} />
                <Route path="/me" element={<MePage />} />
              </Route>
              {/* Full-screen pages — no NavBar */}
              <Route path="/chat/remi" element={<RemiChatPage />} />
              <Route path="/chat/:pubKey" element={<AvatarChatPage />} />
              <Route path="/profile/:pubKey" element={<ProfilePage />} />
              <Route path="/stats" element={<StatsPage />} />
              <Route path="/anchors" element={<AnchorsPage />} />
              <Route path="/share" element={<SharePage />} />
              <Route path="/settings" element={<SettingsPage />} />
              {/* Backward compat: old share links */}
              <Route path="/s/:pubKey" element={<OldShareRedirect />} />
              {/* Default redirect */}
              <Route path="*" element={<Navigate to="/messages" replace />} />
            </Routes>
            <Toaster position="top-center" />
          </TooltipProvider>
        </AuthProvider>
      </BrowserRouter>
    </Suspense>
  );
}
