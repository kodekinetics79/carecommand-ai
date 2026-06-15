import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import './index.css'
import { initUiPrefs } from './lib/uiPrefs'

// Apply saved sidebar collapse + accent theme before first paint.
initUiPrefs()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
