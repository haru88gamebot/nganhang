import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { setupApiClient } from "@/lib/api-setup";
import { Layout } from "@/components/layout";
import Dashboard from "@/pages/dashboard";
import Settings from "@/pages/settings";
import Users from "@/pages/users";
import Transactions from "@/pages/transactions";
import GiftCodes from "@/pages/gift-codes";
import Support from "@/pages/support";

setupApiClient();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/settings" component={Settings} />
        <Route path="/users" component={Users} />
        <Route path="/transactions" component={Transactions} />
        <Route path="/gift-codes" component={GiftCodes} />
        <Route path="/support" component={Support} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
