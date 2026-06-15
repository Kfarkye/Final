import { BrowserRouter as Router, Routes, Route, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import LandingPage from './LandingPage';
import Onboarding from './Onboarding';
import ChatClient from './ChatClient';

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/chat" element={<ChatClient />} />
      </Routes>
    </Router>
  );
}
