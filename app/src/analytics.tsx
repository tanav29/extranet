import { createRoot } from "react-dom/client";
import "@/index.css";
import AnalyticsApp from "@/pages/AnalyticsApp";
import { Toaster } from "@/components/ui/sonner";

createRoot(document.getElementById("root")!).render(
  <>
    <AnalyticsApp />
    <Toaster />
  </>
);
