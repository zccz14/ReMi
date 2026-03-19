import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Suspense } from "react";
import { AuthProvider } from "./hooks/use-auth";
import { AppShell } from "./components/layout/AppShell";
import { DashboardPage } from "./pages/DashboardPage";
import { InterviewPage } from "./pages/InterviewPage";
import { AnchorsPage } from "./pages/AnchorsPage";
import { AvatarChatPage } from "./pages/AvatarChatPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SharePage } from "./pages/SharePage";
import "./lib/i18n";

export default function App() {
  return (
    <Suspense
      fallback={<div className="flex items-center justify-center min-h-screen">Loading...</div>}
    >
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/interview" element={<InterviewPage />} />
              <Route path="/anchors" element={<AnchorsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/share" element={<SharePage />} />
            </Route>
            {/* Avatar chat — no NavBar, full screen */}
            <Route
              path="/s/:pubKey"
              element={
                <div className="h-screen max-w-lg mx-auto">
                  <AvatarChatPage />
                </div>
              }
            />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </Suspense>
  );
}
