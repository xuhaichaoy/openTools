import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ToastProvider } from '@/components/ui/Toast'
import { GlobalErrorBoundary } from '@/core/errors/ErrorBoundary'
import { installPageLifecycleDebug } from '@/core/debug/page-lifecycle-debug'
import './index.css'

installPageLifecycleDebug()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GlobalErrorBoundary>
      <ToastProvider>
        <App />
      </ToastProvider>
    </GlobalErrorBoundary>
  </React.StrictMode>
)
