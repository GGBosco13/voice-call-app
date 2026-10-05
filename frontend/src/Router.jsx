import { AuthProvider } from './hooks/useAuth';
import App from './App';

export default function Router() {
  return (
    <AuthProvider>
      <App />
    </AuthProvider>
  );
}
