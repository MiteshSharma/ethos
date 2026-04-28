import { useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { Chat } from './pages/Chat';
import { Onboarding } from './pages/Onboarding';
import { Sessions } from './pages/Sessions';
import { SigningIn } from './pages/SigningIn';

// Top-level route map. v0 ships only Talk-group routes (Chat + Sessions)
// plus the onboarding flow and the signing-in placeholder. Agent / Ops /
// Lab / System groups arrive in v0.5+ — sidebar already groups them so
// future tabs slot in without restructuring.

export function App() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`app-shell${collapsed ? ' collapsed' : ''}`}>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
      <TopBar />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/signing-in" element={<SigningIn />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </main>
    </div>
  );
}
