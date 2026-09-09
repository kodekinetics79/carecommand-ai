import { AuthProvider } from './src/session';
import { AppGate } from './src/screens';

export default function App() {
  return <AuthProvider><AppGate /></AuthProvider>;
}
