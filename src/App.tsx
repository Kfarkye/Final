import { BrowserRouter as Router, Routes, Route, useNavigate } from 'react-router-dom';
import { useState, useEffect, lazy, Suspense } from 'react';
import LandingPage from './LandingPage';
import Onboarding from './Onboarding';
import ChatClient from './ChatClient';
import ControlPlane from './components/ControlPlane';

const MobileChat = lazy(() => import('./MobileChat'));

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/chat" element={<ChatClient />} />
        <Route path="/admin/control-plane" element={<ControlPlane />} />
        <Route path="/mobile" element={<Suspense fallback={<div style={{background:'#0A0A0F',height:'100dvh'}} />}><MobileChat /></Suspense>} />
      </Routes>
    </Router>
  );
}
