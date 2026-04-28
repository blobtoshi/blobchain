import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Index from "./pages/Index.tsx";

import NotFound from "./pages/NotFound.tsx";
import AlphaLock from "./components/AlphaLock";
import { RelayStatusBadge } from "@/components/blob/RelayStatusBadge";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <AlphaLock>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Index />} />
            
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </AlphaLock>
      {import.meta.env.DEV && <RelayStatusBadge />}
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
