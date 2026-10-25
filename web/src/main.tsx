import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ApiError } from "./api/client";
import { SETTINGS_UNLOCK_KEY } from "./components/SettingsLock";
import { ToastProvider } from "./components/toast";
import { AuthProvider } from "./hooks/auth";
import { ThemeProvider } from "./hooks/theme";
import "./index.css";

// Settings locked on the server (no recent password): show the lock.
const settingsLocked = (err: unknown) => {
  if (err instanceof ApiError && err.code === "PASSWORD_CONFIRMATION_REQUIRED") void queryClient.invalidateQueries({ queryKey: SETTINGS_UNLOCK_KEY });
};
const queryClient: QueryClient = new QueryClient({
  // Every change made in the app writes an audit entry, so show it straight away.
  mutationCache: new MutationCache({
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["audit"] }),
    onError: (err) => settingsLocked(err),
  }),
  queryCache: new QueryCache({ onError: (err) => settingsLocked(err) }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      placeholderData: (prev: unknown) => prev, // keep the previous render while refetching
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
