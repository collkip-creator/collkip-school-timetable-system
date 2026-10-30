import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TeacherMobilePortal } from './TeacherMobile';
import './index.css';

// The Android teacher companion is a native-app experience. Pairing is performed
// by the in-app QR scanner rather than by opening a browser URL.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TeacherMobilePortal />
  </StrictMode>,
);
