import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TeacherMobilePortal } from './TeacherMobile';
import './index.css';

const pairingToken = new URLSearchParams(window.location.search).get('teacherPair') || undefined;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TeacherMobilePortal pairingToken={pairingToken} />
  </StrictMode>,
);
