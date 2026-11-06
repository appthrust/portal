import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { I18nProvider, useLanguage } from './i18n'
import './styles.css'

// A stale deployment chunk gets one full navigation per tab session, never a reload loop.
window.addEventListener('vite:preloadError', (event) => {
  const key = 'portal:preload-reloaded'
  try {
    if (sessionStorage.getItem(key)) return
    sessionStorage.setItem(key, '1')
  } catch {
    // Without persistent storage a reload cannot be bounded across document loads.
    return
  }
  event.preventDefault()
  window.location.reload()
})

const queryClient = new QueryClient()

function LocalizedApp() {
  const language = useLanguage()
  return (
    <I18nProvider language={language}>
      <App />
    </I18nProvider>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LocalizedApp />
    </QueryClientProvider>
  </StrictMode>
)
