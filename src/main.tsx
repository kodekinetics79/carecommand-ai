import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import './index.css'
import './semantic-colour-overrides.css'
import './demo-experience.css'
import { initUiPrefs } from './lib/uiPrefs'
import { installPreloadRecovery } from './lib/preloadRecovery'

// Recover an authenticated tab whose old shell references a route chunk that a
// newer deployment replaced. The guard reloads once per failed asset signature.
installPreloadRecovery()

// Apply saved sidebar collapse + accent theme before first paint.
initUiPrefs()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
