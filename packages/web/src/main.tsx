import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { AuthMiniProvider } from "auth-mini-react-components"
import "linkit-react-components/styles.css"
import "./index.css"
import App from "./App"

createRoot(document.getElementById("root")!).render(<StrictMode><AuthMiniProvider authMiniBaseUrl="https://auth.ntnl.io" autoRedirectToLogin><App /></AuthMiniProvider></StrictMode>)
