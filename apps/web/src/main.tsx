import React from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "./App"
import "./styles.css"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Design state arrives over SSE, so background refetching would fight the stream.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

const container = document.getElementById("root")
if (!container) throw new Error("#root is missing from index.html")

createRoot(container).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
)
