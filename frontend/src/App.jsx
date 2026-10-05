import { useAuth } from './hooks/useAuth';
import CallerCallScreen from './components/CallerCallScreen';
import StaffLogin from './components/StaffLogin';
import StaffDashboard from './components/StaffDashboard';

export default function App() {
  const { role } = useAuth();

  switch (role) {
    case 'caller':
      return <CallerCallScreen />;
    case 'staff':
      return <StaffDashboard />;
    case 'login':
      return <StaffLogin />;
    default:
      return <CallerCallScreen />; // Default to caller view
  }
}
