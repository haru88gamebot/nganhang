import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";

export function setupApiClient() {
  setBaseUrl("/bot-api");
  setAuthTokenGetter(() => {
    return localStorage.getItem("admin_token") || "open-access";
  });
}
