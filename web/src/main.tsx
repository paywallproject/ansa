import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@fontsource-variable/inter'
import './index.css'
import { App } from './App'
import { FeedbackProvider } from './ui'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (count, error: any) => error?.status !== 404 && error?.status !== 401 && count < 2, refetchOnWindowFocus: true, staleTime: 5_000 } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <FeedbackProvider>
          <App />
        </FeedbackProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
