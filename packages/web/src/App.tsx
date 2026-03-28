import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { Suspense } from "react";
import { AuthProvider } from "./hooks/use-auth";
import { PwaInstallProvider } from "./hooks/use-pwa-install";
import { PwaUpdateProvider } from "./hooks/use-pwa-update";
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
import { AnchorsPage } from "./pages/AnchorsPage";
import { ReadingPage } from "./pages/ReadingPage";
import { SharePage } from "./pages/SharePage";
import { SettingsPage } from "./pages/SettingsPage";
import { ApprovalPage } from "./pages/ApprovalPage";
import "./lib/i18n";

function OldShareRedirect() {
  const { pubKey } = useParams<{ pubKey: string }>();
  return <Navigate to={`/profile/${pubKey}`} replace />;
}

function AuthenticatedRoutes() {
  return (
    <AuthProvider>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/messages" element={<MessagesPage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/approval/:kind" element={<ApprovalPage />} />
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/me" element={<MePage />} />
        </Route>
        <Route path="/chat/remi" element={<RemiChatPage />} />
        <Route path="/chat/:pubKey" element={<AvatarChatPage />} />
        <Route path="/anchors" element={<AnchorsPage />} />
        <Route path="/read" element={<ReadingPage />} />
        <Route path="/share" element={<SharePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/approval/anchors" replace />} />
      </Routes>
    </AuthProvider>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={<div className="flex items-center justify-center min-h-screen">Loading...</div>}
    >
      <BrowserRouter>
        <TooltipProvider>
          <PwaInstallProvider>
            <PwaUpdateProvider>
              <Routes>
                <Route path="/profile/:pubKey" element={<ProfilePage />} />
                <Route path="/s/:pubKey" element={<OldShareRedirect />} />
                <Route path="*" element={<AuthenticatedRoutes />} />
              </Routes>
            </PwaUpdateProvider>
          </PwaInstallProvider>
          <Toaster position="top-center" />
        </TooltipProvider>
      </BrowserRouter>
    </Suspense>
  );
}
