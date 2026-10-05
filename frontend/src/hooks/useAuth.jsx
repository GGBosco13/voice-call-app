import { createContext, useContext, useState, useEffect } from 'react';

// ============================================================
// Auth context — tracks the current user role
// Roles: 'caller' (anonymous), 'staff' (authenticated)
// The caller session is always anonymous — no PII stored.
// ============================================================

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [role, setRole] = useState(null);
  const [staffToken, setStaffToken] = useState(null);
  const [staffId, setStaffId] = useState(null);

  // Check URL params for role selection
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roleParam = params.get('role');

    if (roleParam === 'staff') {
      const token = localStorage.getItem('whisper_staff_token');
      const sid = localStorage.getItem('whisper_staff_id');
      if (token && sid) {
        setStaffToken(token);
        setStaffId(sid);
        setRole('staff');
      } else {
        setRole('login');
      }
    } else {
      setRole('caller');
    }
  }, []);

  // Clear staff session (logout)
  const logout = () => {
    setStaffToken(null);
    setStaffId(null);
    localStorage.removeItem('whisper_staff_token');
    localStorage.removeItem('whisper_staff_id');
  };

  // Set staff session after login
  const setSession = (token, id) => {
    setStaffToken(token);
    setStaffId(id);
    localStorage.setItem('whisper_staff_token', token);
    localStorage.setItem('whisper_staff_id', id);
    window.location.href = '/?role=staff';
  };

  return (
    <AuthContext.Provider value={{ role, staffToken, staffId, logout, setSession }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
